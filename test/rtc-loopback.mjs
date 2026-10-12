// WebRTC 迁移可行性 PoC（第一步：纯 Bun 进程内环回，先不谈浏览器）
// 一个"服务端 PC"对一个"客户端 PC"，共 N 对——这就是真实服务器要持有的结构（每玩家一条 DTLS+SCTP）。
// 量三件决定成败的事：
//   1) 不可靠无序通道（ordered:false + maxRetransmits:0，即换 UDP 想要的语义）能否握手、耗时多少
//   2) 它的往返时延，以及 20Hz 快照节律下的送达率
//   3) 每多一个对端要付多少 CPU —— 决定 6 座 × 多房间能不能在 120Hz 物理仿真旁边同时跑
// 用法：bun test/rtc-loopback.mjs [对端数]
import { RTCPeerConnection } from 'werift';

const N = Number(process.argv[2] || 6);
const FRAME = 120; // 一份全量快照的量级（字节）
const asBytes = (m) => {
  if (m instanceof Uint8Array) return m;
  const d = m && m.data !== undefined ? m.data : m;
  return d instanceof Uint8Array ? d : new Uint8Array(d);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = performance.now();
const pairs = [];

for (let i = 0; i < N; i++) {
  const srv = new RTCPeerConnection({ iceServers: [] });
  const cli = new RTCPeerConnection({ iceServers: [] });
  // 客户端侧发起 offer，服务端侧收到通道 —— 与真实浏览器接入方向一致
  const ch = cli.createDataChannel('race', { ordered: false, maxRetransmits: 0 });
  const p = { srv, cli, ch, srvCh: null, open: false, got: 0, bytes: 0, rt: [] };
  pairs.push(p);
  ch.onopen = () => { p.open = true; };
  ch.onmessage = (m) => {
    const b = asBytes(m);
    p.got++; p.bytes += b.length;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // 服务端是原样回显，所以回来的还是 'PING' 标记；只看 16 字节这一种帧
    if (b.length === 16 && dv.getUint32(0) === 0x50494e47) p.rt.push(performance.now() - dv.getFloat64(8));
  };
  srv.onDataChannel.subscribe((sc) => {
    p.srvCh = sc;
    sc.onmessage = (m) => sc.send(asBytes(m)); // 回显：把客户端发的每一帧原样送回去
  });
  // ICE 互喂：环回只有 host candidate，不需要 STUN
  cli.onIceCandidate.subscribe((c) => srv.applyRemoteIceCandidate(c).catch(() => {}));
  srv.onIceCandidate.subscribe((c) => cli.applyRemoteIceCandidate(c).catch(() => {}));
}

const hsT0 = performance.now();
for (const p of pairs) {
  // werift 的 localDescription 本身就是 {type,sdp}，不要再套一层 RTCSessionDescription
  await p.cli.setLocalDescription(await p.cli.createOffer());
  await p.srv.setRemoteDescription(p.cli.localDescription);
  await p.srv.setLocalDescription(await p.srv.createAnswer());
  await p.cli.setRemoteDescription(p.srv.localDescription);
}
const deadline = performance.now() + 10000;
while (performance.now() < deadline && !pairs.every((p) => p.open)) await wait(20);
const ready = pairs.filter((p) => p.open).length;
console.log(`握手：${ready}/${N} 对成功 · 全部就绪用时 ${(performance.now() - hsT0).toFixed(0)}ms（含 DTLS+SCTP）`);
if (ready === 0) { console.log('FAIL Bun 内 WebRTC 数据通道跑不起来'); process.exit(1); }

// ---------- 往返时延：每对客户端发 PING(16B)，服务端原样回 ----------
for (let round = 0; round < 60; round++) {
  for (const p of pairs) {
    if (!p.open) continue;
    const b = new Uint8Array(16);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x50494e47); // 'PING'
    dv.setFloat64(8, performance.now());
    p.ch.send(b);
  }
  await wait(16);
}
await wait(500);
const all = pairs.flatMap((p) => p.rt).sort((a, b) => a - b);
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);
console.log(`往返时延（同进程环回 = 纯协议栈开销，不含网络）：中位 ${q(all, 0.5).toFixed(3)}ms · p95 ${q(all, 0.95).toFixed(3)}ms · 样本 ${all.length}/${ready * 60}`);

// ---------- 送达率：一条通道按 20Hz 推 3 秒 ----------
const p0 = pairs[0];
p0.got = 0; p0.bytes = 0;
for (let i = 0; i < 60; i++) { if (p0.open) p0.ch.send(new Uint8Array(FRAME)); await wait(50); }
await wait(300);
console.log(`单通道 20Hz×60 帧：送达 ${p0.got}/60 · ${(p0.bytes / 1024).toFixed(1)}KB/3s`);

// ---------- 满载 CPU：N 条通道同时 20Hz 推 3 秒 ----------
const load0 = process.cpuUsage();
const wall0 = performance.now();
for (const p of pairs) p.got = 0;
const timers = pairs.filter((p) => p.open).map((p) => setInterval(() => p.ch.send(new Uint8Array(FRAME)), 50));
await wait(3000);
for (const t of timers) clearInterval(t);
await wait(400);
const delivered = pairs.reduce((a, p) => a + p.got, 0);
const pctOf = (c, s) => ((c.user + c.system) / 1e6 / s) * 100;
const corePct = pctOf(process.cpuUsage(load0), (performance.now() - wall0) / 1000);
console.log(`满载 ${ready} 对端 ×20Hz×${FRAME}B：送达 ${delivered}/${ready * 60} 帧 · DTLS/SCTP 合计 ${corePct.toFixed(1)}% 单核（${(corePct / ready).toFixed(2)}% / 对端）`);

// ---------- 空闲常驻：通道挂着但不发 ----------
const idle0 = process.cpuUsage();
const idleW = performance.now();
await wait(2000);
console.log(`空闲基线（${ready} 对挂着、零流量）：${pctOf(process.cpuUsage(idle0), (performance.now() - idleW) / 1000).toFixed(2)}% 单核`);

console.log(`粗算：单核 100% 大约能养 ${Math.round(100 / Math.max(0.01, corePct / ready))} 个这种对端（还没算 120Hz 物理仿真本身）`);
for (const p of pairs) { p.cli.close(); p.srv.close(); }
console.log(`总用时 ${(performance.now() - t0).toFixed(0)}ms`);
