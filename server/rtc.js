// WebRTC 传输层：每个玩家一条 PeerConnection，两条数据通道。
//
// 为什么这样切：
//  · fast   —— ordered:false + maxRetransmits:0，SCTP 不为它做任何重传与排序，就是"UDP 语义"。
//    快照与事件走这条：丢一包没有连锁后果（每份快照都是自包含全量状态，下一包 50ms 就到），
//    而且再也不会出现"一包重传、后面全部等它"的队头阻塞——那正是高延迟下画面一抽一抽的来源。
//  · ctl    —— 可靠有序。握手/名单/准备/结算/结果/PING 走这条，它们必须一次不少、顺序不能乱。
//  · 本车上行的输入也走 ctl：一个输入包里带着"这一帧按下了道具/氮气"的边沿位，
//    边沿位丢了没法靠下一包补回来（发出去就从 pending 删了），而实测不可靠通道即使在
//    零丢包的本机链路上也会自丢约 3% —— 那就是 3% 的"玩家按了没反应"。
//    上行包只有 20 字节，为重传它等一个 RTT 的代价由本端预测吸收，远小于吃掉按键。
//
// 服务器为什么不需要 STUN/TURN：iceLite —— 本端不做连通性检查，只回应玩家发来的检查。
// 玩家（Chrome）是 ICE 控制端，它会主动向服务器 advertised 的候选地址发包，服务器从"包从哪儿来"
// 就学会了玩家的地址，NAT 打洞方向天然是"由玩家往外打"。所以只需要：
//  1) 服务器的公网地址能被写进候选（EIP 直绑时 RTC_PUBLIC_IP 填公网 IP，或用网卡地址）
//  2) 安全组放行这一段 UDP（RTC_PORT_RANGE）
import { RTCPeerConnection } from 'werift';
import { S } from '../shared/proto.js';

// 只有下行需要选通道：快照与事件走不可靠通道，其余走可靠通道。
// 上行不必分流——玩家输入全部走可靠通道（见文件头的边沿位说明）。
const FAST_DOWN = new Set([S.SNAP, S.EVENT]);

const asBytes = (m) => {
  if (m instanceof Uint8Array) return m;
  const d = m && m.data !== undefined ? m.data : m;
  return d instanceof Uint8Array ? d : new Uint8Array(d);
};

const RANGE = process.env.RTC_PORT_RANGE || '';
const RM = RANGE.match(/^(\d+)-(\d+)$/);
const PORT_RANGE = RM ? [Number(RM[1]), Number(RM[2])] : undefined;
const PUBLIC_IP = (process.env.RTC_PUBLIC_IP || '').trim();

// 通道缓冲超过这个量就不再往 fast 里塞（宁可丢快照，也不把延迟堆成排队）
const FAST_QUEUE_LIMIT = 32000;
// 一直没发过 HELLO 的连接视为僵尸（信令成功但页面被关掉），回收掉
const ORPHAN_MS = 20000;
// 应用层保活：客户端每 1s 发 PING，超过这个时间没收到任何东西就判定掉线
const IDLE_MS = 12000;

export function createRtcHub({ onMessage, onClose, onError }) {
  const peers = new Map(); // peerId -> Peer
  let seq = 1;
  let lastError = '';

  class Peer {
    constructor(id, pc) {
      this.id = id;
      this.pc = pc;
      this.ctl = null;
      this.fast = null;
      this.helloAt = 0;
      this.lastRecv = Date.now();
      this.dead = false;
      this.bytesOut = 0;
      this.framesOut = 0;
      this.framesFastDrop = 0;
      // room.js 沿用 WS 时代的句柄形状：连接身份放在 data.connId
      this.data = { connId: id };
      peers.set(id, this);
    }

    channel(type) {
      return FAST_DOWN.has(type) ? this.fast : this.ctl;
    }

    get open() {
      return !!this.ctl && this.ctl.readyState === 'open' && !this.dead;
    }

    send(bytes) {
      if (this.dead || !bytes || !bytes.length) return;
      const ch = this.channel(bytes[0]);
      if (!ch || ch.readyState !== 'open') return;
      if (ch === this.fast && ch.bufferedAmount > FAST_QUEUE_LIMIT) {
        // 快照队列都在 32KB 之外了：这条链路已经不是"慢"而是"堵"，丢掉旧的比留着更有帮助
        this.framesFastDrop++;
        return;
      }
      try { ch.send(bytes); this.bytesOut += bytes.length; this.framesOut++; } catch { this.markDead(); }
    }

    markDead() {
      if (this.dead) return;
      this.dead = true;
      peers.delete(this.id);
      try { this.pc.close(); } catch { /* 已经关了 */ }
      try { onClose?.(this); } catch { /* 房间已经收了 */ }
    }

    close() { this.markDead(); }
  }

  // 非 trickle 信令：候选收齐再回 SDP。werift 没有暴露 iceGatheringState 的稳定读法，
  // 这里直接看 SDP 里有没有出现 udp host 候选——本机起服务时这一步几乎是即时的。
  async function settledSdp(pc) {
    const t = Date.now();
    let sdp = pc.localDescription?.sdp || '';
    while (Date.now() - t < 1200) {
      if (/a=candidate:\S+\s+\d+\s+udp\b/i.test(sdp)) {
        const before = sdp;
        await new Promise((r) => setTimeout(r, 120));
        const after = pc.localDescription?.sdp || '';
        if (after === before) return after;
        sdp = after;
        continue;
      }
      await new Promise((r) => setTimeout(r, 60));
      sdp = pc.localDescription?.sdp || '';
    }
    return sdp;
  }

  async function offer(body) {
    if (!body || typeof body.sdp !== 'string') return { error: 'bad offer' };
    const pc = new RTCPeerConnection({
      iceServers: [], // 服务器不借外部 STUN： advertised 地址来自 RTC_PUBLIC_IP / 网卡地址
      iceLite: true,  // 只应答玩家发来的连通性检查，不主动检查玩家（因此不需要 TURN）
      icePortRange: PORT_RANGE,
      iceAdditionalHostAddresses: PUBLIC_IP ? [PUBLIC_IP] : undefined,
      iceUseTcp: false,
    });
    const peer = new Peer(seq++, pc);

    pc.onDataChannel.subscribe((ch) => {
      if (ch.label === 'fast') peer.fast = ch; else peer.ctl = ch;
      ch.onmessage = (m) => {
        const bytes = asBytes(m);
        peer.lastRecv = Date.now();
        if (!peer.helloAt) peer.helloAt = Date.now();
        try { onMessage(peer, bytes); } catch (e) { lastError = String(e?.message || e); onError?.(e); }
      };
      ch.onclose = () => peer.markDead();
    });
    pc.connectionStateChange.subscribe((s) => { if (s === 'failed' || s === 'closed') peer.markDead(); });

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
    } catch (e) {
      peer.markDead();
      lastError = String(e?.message || e);
      return { error: 'answer failed' };
    }
    const sdp = await settledSdp(pc);
    return { sdp, peerId: peer.id, udpRange: PORT_RANGE ? RANGE : '系统分配', publicIp: PUBLIC_IP || '本机网卡地址' };
  }

  // 定时回收：只会话建立却没发 HELLO 的僵尸连接，以及静默超时的连接
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const p of [...peers.values()]) {
      if (!p.helloAt) { if (now - p.lastRecv > ORPHAN_MS) p.markDead(); continue; }
      if (now - p.lastRecv > IDLE_MS) p.markDead();
    }
  }, 2000);
  sweeper.unref?.();

  return {
    offer,
    peers,
    get count() { return peers.size; },
    info() {
      return {
        transport: 'webrtc',
        peers: peers.size,
        udpRange: PORT_RANGE ? RANGE : 'auto',
        publicIp: PUBLIC_IP || 'auto',
        lastError,
      };
    },
    stop() { clearInterval(sweeper); for (const p of [...peers.values()]) p.markDead(); },
  };
}
