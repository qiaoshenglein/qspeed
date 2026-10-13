// 下行快照到底丢没丢：只看相邻两份快照的 tick 间隔。
// 服务器每 6 个 tick 发一份（120Hz/20Hz），所以间隔应当是 6；出现 12 就是丢了一份，18 就是丢了两份。
// 本机回环上若出现 12+，说明丢帧来自传输栈或我们自己的丢包策略，而不是网络。
// 同时给出服务器侧计数增量，用来区分"链路真丢"与"服务器发不出去（背压丢弃）"。
// 用法：bun test/rtc-loss.mjs [秒数]                                     本机起一个服务器测
//       REMOTE_SIGN=http://HOST:8790/rtc/offer bun test/rtc-loss.mjs 20   测真实公网链路
//       （远端模式会在对方机器上开一个 2 人房间，测完自动退房）
import { signUrl } from './rtc-node.mjs';
import { NetCore } from '../shared/session.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel, placeOnGrid } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECS = Number(process.argv[2] || 6);
const REMOTE = (process.env.REMOTE_SIGN || '').trim();
const PORT_FILE = ROOT + '.tmp/rtc-loss-port';

let child = null;
let origin = '';
let sign = '';
if (REMOTE) {
  origin = new URL(REMOTE).origin;
  sign = REMOTE;
} else {
  try { await Bun.write(PORT_FILE, ''); } catch {}
  child = Bun.spawn([process.execPath, 'server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, ADMIN_TOKEN: 'k' },
    stdout: 'ignore', stderr: 'ignore',
  });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    const s = (await Bun.file(PORT_FILE).text()).trim();
    if (s) port = Number(s); else await Bun.sleep(50);
  }
  if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }
  origin = `http://localhost:${port}`;
  sign = signUrl(port);
}
const health = async () => { try { return (await (await fetch(`${origin}/healthz`)).json()).rtc || {}; } catch { return {}; } };

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const steer = (car) => {
  const s = track.sample(car.d + 22, {});
  const e = ((Math.atan2(s.x - car.x, s.z - car.z) - car.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return { up: true, down: false, left: e > 0.03, right: e < -0.03, shift: false, upPressed: false, wPressed: false, nitroPressed: false };
};

const nets = [];
for (let i = 0; i < 2; i++) {
  const car = new PlayerCar(track, stubModel(), `车${i}`);
  placeOnGrid(car, 0);
  const net = new NetCore({ url: sign, name: `测${i}`, skin: i, map: 'city', laps: 2, mode: 0, diff: 1, create: i === 0, code: '', track, ownCar: car });
  net.gaps = []; net.arrivals = []; net.prevSnapTick = 0; net.lastArr = 0; net.maxErrSeen = 0;
  const os = net.applySnap.bind(net);
  net.applySnap = (snap) => {
    const now = performance.now();
    if (net.prevSnapTick) { net.gaps.push(snap.tick - net.prevSnapTick); net.arrivals.push(now - net.lastArr); }
    net.lastArr = now; net.prevSnapTick = snap.tick;
    return os(snap);
  };
  nets.push(net);
}
const t0 = Date.now();
while (Date.now() - t0 < 20000 && !nets.every((n) => n.roster.length >= 2)) {
  for (const n of nets) n.step(16, steer(n.me), false);
  await Bun.sleep(16);
}
const code = nets[0].code;
console.log(`房间 ${code || '（没拿到房间码）'} · ${REMOTE ? '远端 ' + origin : '本机'} · 名单到位 ${nets.map((n) => n.roster.length).join('/')}`);
if (!code) process.exit(1);
const before = await health();
for (const n of nets) n.ready(true);
if (!REMOTE) {
  await Bun.sleep(300);
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${origin}/api/admin/rooms/${code}/start?key=k`, { method: 'POST' });
    if (r.ok) break;
    await Bun.sleep(150);
  }
}
for (let i = 0; i < 260 && nets.some((n) => n.phase < 2); i++) { for (const n of nets) n.step(16, steer(n.me), false); await Bun.sleep(50); }
console.log(`进入比赛 · 实测 RTT ${nets.map((n) => Math.round(n.rtt)).join('/')}ms`);

const loop = setInterval(() => {
  for (const n of nets) { n.step(16, steer(n.me), n.phase >= 2 && !n.me.finished); n.maxErrSeen = Math.max(n.maxErrSeen, n.maxErr || 0); }
}, 16);
await Bun.sleep(SECS * 1000);
clearInterval(loop);

const after = await health();
for (const n of nets) {
  const g = n.gaps.slice(3);
  const hist = {};
  for (const x of g) hist[x] = (hist[x] || 0) + 1;
  const lost = g.filter((x) => x > 6).reduce((a, x) => a + (x / 6 - 1), 0);
  const arr = [...n.arrivals.slice(3)].sort((a, b) => a - b);
  const q = (p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
  console.log(`${n.me.name}：收快照 ${g.length} 份 · tick 间隔 ${Object.entries(hist).map(([k, v]) => `${k}×${v}`).join(' ')} · 链路丢帧 ${lost.toFixed(0)}（${(lost / Math.max(1, g.length + lost) * 100).toFixed(1)}%）`);
  console.log(`   到达间隔 中位 ${q(0.5).toFixed(0)}ms · p95 ${q(0.95).toFixed(0)}ms · 最大 ${q(0.999).toFixed(0)}ms（远超 50ms = 链路在等重传或服务器卡顿）· 预测误差峰值 ${n.maxErrSeen.toFixed(2)}m · 回滚 ${n.rolls} 次`);
}
const d = (k) => (after[k] || 0) - (before[k] || 0);
console.log(`服务器增量：发出 ${d('sentFrames')} 帧 / ${d('sentKb')}KB · 背压丢弃 ${d('fastDropped')} · 结束时在线 ${after.peers}`);
for (const n of nets) { n.leave(); n.dispose(); }
if (child) child.kill();
process.exit(0);
