// 一把测清楚：把 N 个 WebRTC 客户端跑在同一个 Bun 进程里，帧循环会被拖到什么程度。
// 浏览器里 DTLS/SCTP 与游戏同进程，所以这个数字就是"测试机能测出的上限"；
// 服务器侧每个对端的开销另由 test/rtc-loopback.mjs 量（0.77% 单核 / 对端）。
// 用法：bun test/rtc-load.mjs [客户端数]
import { signUrl } from './rtc-node.mjs';
import { NetCore } from '../shared/session.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel, placeOnGrid } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const N = Number(process.argv[2] || 4);
const PORT_FILE = ROOT + '.tmp/rtc-load-port';
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
for (let i = 0; i < N; i++) {
  const car = new PlayerCar(track, stubModel(), `车${i}`);
  placeOnGrid(car, 0);
  const net = new NetCore({ url: signUrl(port), name: `车${i}`, skin: i, map: 'city', laps: 2, mode: 0, diff: 1, create: i === 0, code: '', track, ownCar: car });
  net.frames = [];
  nets.push(net);
}
const t0 = Date.now();
while (Date.now() - t0 < 8000 && !nets.every((n) => n.roster.length >= N)) {
  for (const n of nets) n.step(16, steer(n.me), false);
  await Bun.sleep(16);
}
const code = nets[0].code;
for (const n of nets) n.ready(true);
await Bun.sleep(300);
await fetch(`http://localhost:${port}/api/admin/rooms/${code}/start?key=k`, { method: 'POST' }).catch(() => {});
for (let i = 0; i < 200 && nets.some((n) => n.phase < 2); i++) { for (const n of nets) n.step(16, steer(n.me), false); await Bun.sleep(30); }

const clk = { last: performance.now(), max: 0, over50: 0, n: 0, worst: [] };
const cpu0 = process.cpuUsage();
const wall0 = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  const dt = now - clk.last;
  clk.last = now;
  clk.n++;
  if (dt > clk.max) { clk.max = dt; }
  if (dt > 50) { clk.over50++; clk.worst.push({ dt: +dt.toFixed(0), at: +(now / 1000).toFixed(2) }); }
  for (const n of nets) n.step(Math.min(200, dt), steer(n.me), n.phase >= 2 && !n.me.finished);
}, 16);

await Bun.sleep(5000);
clearInterval(loop);
const cpu = process.cpuUsage(cpu0);
const secs = (performance.now() - wall0) / 1000;
const snaps = nets.reduce((a, n) => a + n.snapCount, 0);
console.log(`${N} 个 WebRTC 客户端同进程 · ${secs.toFixed(1)}s：帧数 ${clk.n} · 最长帧 ${clk.max.toFixed(0)}ms · >50ms 帧 ${clk.over50} (${(clk.over50 / clk.n * 100).toFixed(1)}%)`);
console.log(`本进程 CPU ${((cpu.user + cpu.system) / 1e6 / secs * 100).toFixed(0)}% 单核 · 收快照 ${snaps} 份（应约 ${N * 100}）· 实测 RTT ${nets.map((n) => Math.round(n.rtt)).join('/')}ms`);
if (clk.worst.length) console.log(`最坏几帧：${clk.worst.sort((a, b) => b.dt - a.dt).slice(0, 5).map((w) => `${w.dt}ms@${w.at}s`).join(' · ')}`);
for (const n of nets) n.dispose();
child.kill();
process.exit(0);
