// 下行快照到底丢没丢：只看相邻两份快照的 tick 间隔。
// 服务器每 6 个 tick 发一份（120Hz/20Hz），所以间隔应当是 6；出现 12 就是丢了一份，18 就是丢了两份。
// 这个量与"网络好不好"无关：本机回环上若出现 12+，说明丢包是传输栈或我们的丢包策略造成的。
// 用法：bun test/rtc-loss.mjs [秒数]
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
const PORT_FILE = ROOT + '.tmp/rtc-loss-port';
try { await Bun.write(PORT_FILE, ''); } catch {}

const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, ADMIN_TOKEN: 'k' },
  stdout: 'ignore', stderr: 'ignore',
});
let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) port = Number(s); else await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }

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
  const net = new NetCore({ url: signUrl(port), name: `车${i}`, skin: i, map: 'city', laps: 2, mode: 0, diff: 1, create: i === 0, code: '', track, ownCar: car });
  net.gaps = [];
  net.prevSnapTick = 0;
  const os = net.applySnap.bind(net);
  net.applySnap = (snap) => {
    if (net.prevSnapTick) net.gaps.push(snap.tick - net.prevSnapTick);
    net.prevSnapTick = snap.tick;
    return os(snap);
  };
  net.maxErrSeen = 0;
  nets.push(net);
}
const t0 = Date.now();
while (Date.now() - t0 < 8000 && !nets.every((n) => n.roster.length >= 2)) {
  for (const n of nets) n.step(16, steer(n.me), false);
  await Bun.sleep(16);
}
const code = nets[0].code;
for (const n of nets) n.ready(true);
await Bun.sleep(300);
for (let i = 0; i < 30; i++) {
  const r = await fetch(`http://localhost:${port}/api/admin/rooms/${code}/start?key=k`, { method: 'POST' });
  if (r.ok) break;
  await Bun.sleep(150);
}
for (let i = 0; i < 200 && nets.some((n) => n.phase < 2); i++) { for (const n of nets) n.step(16, steer(n.me), false); await Bun.sleep(30); }

const wall0 = performance.now();
const loop = setInterval(() => {
  const dt = 16;
  for (const n of nets) {
    n.step(dt, steer(n.me), n.phase >= 2 && !n.me.finished);
    n.maxErrSeen = Math.max(n.maxErrSeen, n.maxErr || 0);
  }
}, 16);
await Bun.sleep(SECS * 1000);
clearInterval(loop);

const h = await (await fetch(`http://localhost:${port}/healthz`)).json();
for (const n of nets) {
  const g = n.gaps.slice(5); // 起手那几份间隔不稳，丢掉
  const hist = {};
  for (const x of g) hist[x] = (hist[x] || 0) + 1;
  const lost = g.filter((x) => x > 6).reduce((a, x) => a + (x / 6 - 1), 0);
  console.log(`${n.me.name}：收快照 ${g.length + 5} 份 · tick 间隔分布 ${Object.entries(hist).map(([k, v]) => `${k}×${v}`).join(' ')} · 推算丢帧 ${lost.toFixed(0)}（${(lost / (g.length / 6 + g.length) * 100).toFixed(1)}%）· 预测误差峰值 ${n.maxErrSeen.toFixed(2)}m · 回滚 ${n.rolls} 次`);
}
console.log(`服务器侧：${JSON.stringify(h.rtc)}`);
for (const n of nets) n.dispose();
child.kill();
process.exit(0);
