// WebRTC 链路中继：在"真实客户端 ↔ 真实服务器"中间插一条可编程的 UDP 语义链路。
// TCP 代理做不到的事它做得到：按消息类型分别丢包。
//   dropSnap  —— 只丢下行快照（对应现实里 20Hz 的 UDP 丢包）
//   dropInput —— 只丢上行输入（对应本车输入的丢失）
// 两条通道各自 FIFO，但互不阻塞：这正是换传输后玩家真正得到的语义差别，
// 也是"队头阻塞"对照组必须用 holdPct 单独模拟的原因。
// 用法：const link = startLink({ sign: 'http://localhost:PORT/rtc/offer', http: 'http://localhost:PORT', upMs, downMs, jitterMs, dropSnap, dropInput })
import { RTCPeerConnection } from 'werift';
import { rtcTransport } from '../shared/transport.js';
import { S, C } from '../shared/proto.js';

globalThis.RTCPeerConnection ??= RTCPeerConnection;

const FAST_DOWN = new Set([S.SNAP, S.EVENT]);
const asBytes = (m) => {
  if (m instanceof Uint8Array) return m;
  const d = m && m.data !== undefined ? m.data : m;
  return d instanceof Uint8Array ? d : new Uint8Array(d);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 一条方向的链路：延迟 + 抖动 + 按类型丢包；同方向内保持 FIFO
function makePipe(rand, baseMs, jitterMs, lossFor, holdFor, holdMs, stats) {
  let lastDepart = 0;
  return (bytes, send) => {
    const roll = rand();
    let dly = Math.max(0, baseMs + (rand() * 2 - 1) * jitterMs);
    const loss = lossFor(bytes, roll);
    if (loss) return loss; // 'dropSnap' / 'dropInput'
    // holdFor：这条"丢了要重传"，于是它和排在它后面的每条都要等它 —— 真实 TCP 的队头阻塞
    if (holdFor && holdFor(bytes, roll)) { dly = Math.max(dly, holdMs || 150); stats.held++; }
    const at = Math.max(Date.now() + dly, lastDepart);
    lastDepart = at;
    setTimeout(() => { try { send(bytes); } catch { /* 已断 */ } }, Math.max(0, at - Date.now()));
  };
}

export function startLink(opt) {
  const rand = rng(opt.seed || 7);
  const stats = { up: 0, down: 0, upBytes: 0, downBytes: 0, dropSnap: 0, dropInput: 0, held: 0, sessions: 0, upErr: 0 };
  const sess = [];

  const downPipe = makePipe(rand, opt.downMs || 0, opt.jitterMs || 0, (b, roll) => {
    if (FAST_DOWN.has(b[0]) && opt.dropSnap && roll * 100 < opt.dropSnap) { stats.dropSnap++; return 'dropSnap'; }
    return null;
  }, opt.holdPct ? (b) => FAST_DOWN.has(b[0]) : null, opt.holdMs, stats);
  const upPipe = makePipe(rand, opt.upMs || 0, opt.jitterMs || 0, (b, roll) => {
    if (b[0] === C.INPUT && opt.dropInput && roll * 100 < opt.dropInput) { stats.dropInput++; return 'dropInput'; }
    return null;
  }, null, 0, stats);

  // 收齐候选再回 SDP（中继对客户端而言就是服务器：iceLite，只应答检查）
  async function settled(pc) {
    const t0 = Date.now();
    let prev = '';
    while (Date.now() - t0 < 2500) {
      const sdp = pc.localDescription?.sdp || '';
      if (/a=candidate:\S+\s+\d+\s+udp\S*\s+\d+\s+\S+\s+\d+\s+typ host/i.test(sdp) && sdp === prev) return sdp;
      prev = sdp;
      await sleep(40);
    }
    return pc.localDescription?.sdp || prev;
  }

  async function handleOffer(req) {
    const { sdp } = await req.json();
    const pc = new RTCPeerConnection({ iceServers: [], iceLite: true, iceUseTcp: false });
    const chs = { ctl: null, fast: null };
    let ready = 0;
    const outQ = []; // 上行通道还没通时，客户端的消息先排队

    // 中继 → 真实服务器：一条全新的客户端连接
    const up = rtcTransport(opt.sign);
    up.onOpen = () => { for (const b of outQ.splice(0)) up.send(b); };
    up.onMessage = (bytes) => { // 服务器下行：按类型选通道再施加延迟/丢包
      stats.down++; stats.downBytes += bytes.byteLength;
      const ch = FAST_DOWN.has(bytes[0]) ? chs.fast : chs.ctl;
      if (ch && ch.readyState === 'open') downPipe(bytes, (b) => ch.send(b));
    };
    up.onClose = () => { try { pc.close(); } catch { /* 已关 */ } };

    const bind = (ch) => {
      if (ch.label === 'fast') chs.fast = ch; else chs.ctl = ch;
      ch.onopen = () => { ready++; };
      ch.onmessage = (m) => {
        const bytes = asBytes(m);
        stats.up++; stats.upBytes += bytes.byteLength;
        const go = () => { if (up.ready) up.send(bytes); else outQ.push(bytes); };
        upPipe(bytes, go);
      };
    };
    pc.onDataChannel.subscribe((ch) => bind(ch));

    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    const answer = await settled(pc);
    stats.sessions++;
    sess.push({ pc, up });
    return { sdp: answer, type: 'answer' };
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/rtc/offer' && req.method === 'POST') {
        try { return Response.json(await handleOffer(req)); } catch (e) { stats.upErr++; return Response.json({ error: String(e?.message || e) }); }
      }
      if (url.pathname === '/__link/stats') return Response.json(stats);
      // 页面本身也从这里加载：浏览器的信令地址是按 location.host 推出来的
      const r = await fetch(opt.http + url.pathname + url.search, { method: req.method, body: req.method === 'GET' ? undefined : req.body });
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/plain' } });
    },
  });

  return {
    port: server.port,
    url: `http://localhost:${server.port}/rtc/offer`,
    base: `http://localhost:${server.port}/`,
    stats,
    close() {
      for (const s of sess) { try { s.pc.close(); } catch { /* 已关 */ } try { s.up.close(); } catch { /* 已关 */ } }
      server.stop(true);
    },
  };
}

// 中继自己跑在独立进程里：它的 DTLS/SCTP 开销不该挤占被测客户端的帧循环，
// 否则量到的是这台机器的调度，而不是链路（帧长一超 40ms，时间类判据就只能跳过）。
export async function spawnLink(opt) {
  // Windows 下 URL.pathname 会带一个前导斜杠（/D:/...），必须剥掉再交给 Bun.spawn
  const fsPath = (u) => u.pathname.replace(/^\/([a-zA-Z]:)/, '$1').replace(/^\//, '');
  const portFile = fsPath(new URL('../.tmp/rtc-link-port', import.meta.url));
  await Bun.write(portFile, '');
  const child = Bun.spawn([process.execPath, fsPath(new URL('./rtc-link.mjs', import.meta.url)), 'HOST'], {
    cwd: fsPath(new URL('..', import.meta.url)),
    env: { ...process.env, LINK_OPT: JSON.stringify(opt), LINK_PORT_FILE: portFile },
    stdout: 'ignore', stderr: 'inherit',
  });
  let port = 0;
  for (let i = 0; i < 120 && !port; i++) {
    const f = await Bun.file(portFile).text();
    const t = f.trim();
    if (t) port = Number(t); else await new Promise((r) => setTimeout(r, 40));
  }
  if (!port) { child.kill(); throw new Error('链路中继起不来'); }
  const api = {
    port,
    url: `http://localhost:${port}/rtc/offer`,
    base: `http://localhost:${port}/`,
    stats: {},
    async poll() {
      try { api.stats = await (await fetch(`http://localhost:${port}/__link/stats`)).json(); } catch { /* 正在关 */ }
      return api.stats;
    },
    async close() { await api.poll(); child.kill(); },
  };
  return api;
}

// 作为独立进程被拉起时：读环境变量、起中继、把端口写回文件
if (process.argv[2] === 'HOST') {
  const opt = JSON.parse(process.env.LINK_OPT || '{}');
  const h = startLink(opt);
  await Bun.write(process.env.LINK_PORT_FILE, String(h.port));
  setInterval(() => {}, 1 << 30);
}
