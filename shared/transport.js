// WebRTC 数据通道 transport（客户端侧）。
// 同一份代码跑在两种运行时：浏览器用原生 RTCPeerConnection，Node/测试里由测试脚本把
// werift 的 RTCPeerConnection 挂到 globalThis 上——这样被测的就是真实通道，不留旁路。
//
// 两条通道的分工（与 server/rtc.js 对称）：
//   ctl  —— 可靠有序：HELLO / READY / LEAVE / PING，以及本车输入
//   fast —— 不可靠无序（ordered:false + maxRetransmits:0）：下行快照与事件
// 输入为什么不能上不可靠通道：一个输入包里带着"这一帧按下了道具/氮气"的边沿位，
// 它不像位姿能靠下一包补回来——发出去就从 pending 里删掉了（session.js flushInput）。
// 实测 werift 的不可靠通道在零丢包的本机链路上也会自丢约 3%，3% 的"按键没反应"不可接受。
// 快照反过来：自包含的全量状态，丢一份下一份 50ms 就到，所以它才适合不可靠通道。
// 信令只有一次 HTTP POST，非 trickle：候选收齐再发，服务端把它的候选写进 answer 直接回。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasHostCandidate(sdp) {
  // Chrome 的 SDP 里传输名是大写 UDP，werift 是小写
  return /a=candidate:\S+\s+\d+\s+udp\S*\s+\d+\s+\S+\s+\d+\s+typ host/i.test(sdp);
}

// 等 ICE 收集稳定：浏览器看 iceGatheringState，Node 侧（werift）看 SDP 里出现 host 候选且不再变
async function settledSdp(pc) {
  const t0 = Date.now();
  let prev = '';
  while (Date.now() - t0 < 3000) {
    const sdp = pc.localDescription?.sdp || '';
    const done = pc.iceGatheringState ? pc.iceGatheringState === 'complete' : hasHostCandidate(sdp);
    if (done && sdp && sdp === prev) return sdp;
    prev = sdp;
    await sleep(40);
  }
  return pc.localDescription?.sdp || prev;
}

export function rtcTransport(url, opt = {}) {
  const RTC = globalThis.RTCPeerConnection;
  if (!RTC) throw new Error('当前运行时没有 RTCPeerConnection：Node 侧需要先注入 werift');
  const pc = new RTC(opt.config || { iceServers: [] });
  const ctl = pc.createDataChannel('ctl', { ordered: true });
  const fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });

  const t = {
    pc, ctl, fast,
    ready: false, closed: false,
    queue: [],          // 通道就绪前攒的下行请求（HELLO 一定在这里）
    bytesOut: 0, bytesIn: 0, framesOut: 0,
    onOpen: null, onMessage: null, onClose: null, onError: null,
  };

  let opened = 0;
  const bind = (ch) => {
    ch.onopen = () => {
      opened++;
      if (opened === 2 && !t.ready) {
        t.ready = true;
        // 先让 onOpen 把 HELLO 发出去，再补排队里的上行：席位是 HELLO 建的，
        // 服务端认不出还没建席位的连接发来的 READY/LEAVE，会直接丢掉。
        // 早先这里是"先冲刷队列再 onOpen"，于是开局手快按准备的人（以及所有在握手期
        // 就 ready 的测试）永远准备不上——房间卡在房间界面不倒计时。
        t.onOpen?.();
        for (const b of t.queue.splice(0)) t.send(b);
      }
    };
    ch.onclose = () => t.close();
    ch.onmessage = (m) => {
      const d = m && m.data !== undefined ? m.data : m;
      const bytes = d instanceof Uint8Array ? d : new Uint8Array(d);
      t.bytesIn += bytes.byteLength;
      t.onMessage?.(bytes);
    };
  };
  bind(ctl); bind(fast);

  const dead = (s) => {
    if (s === 'failed' || s === 'closed' || s === 'disconnected') t.close();
  };
  if (pc.onIceConnectionStateChange?.subscribe) pc.onIceConnectionStateChange.subscribe(dead);
  else pc.oniceconnectionstatechange = () => dead(pc.iceConnectionState);

  t.send = (bytes) => {
    if (t.closed) return;
    if (!t.ready) { t.queue.push(bytes); return; }
    if (!ctl || ctl.readyState !== 'open') { t.queue.push(bytes); return; }
    try { ctl.send(bytes); t.bytesOut += bytes.byteLength; t.framesOut++; } catch { t.close(); }
  };

  t.close = () => {
    if (t.closed) return;
    t.closed = true;
    t.ready = false;
    try { pc.close(); } catch { /* 已经关了 */ }
    t.onClose?.();
  };

  (async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = await settledSdp(pc);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: pc.localDescription?.type || 'offer', sdp }),
      });
      const j = await res.json();
      if (!res.ok || j.error || !j.sdp) { t.onError?.(j.error || '信令失败'); t.close(); return; }
      await pc.setRemoteDescription({ type: j.type || 'answer', sdp: j.sdp });
    } catch (e) {
      t.onError?.(String(e?.message || e));
      t.close();
    }
  })();

  return t;
}
