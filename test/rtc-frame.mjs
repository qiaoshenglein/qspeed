// 卡顿的真正证据在客户端：每一帧用了多久、视觉偏差被压到多深、镜头有没有硬切。
// 快照到达间隔只说明网络，说明不了画面。这个探针把三者一起报出来。
//   bun test/rtc-frame.mjs [秒数]                                   连本机新建的服务器
//   REMOTE_SIGN=http://HOST:8790/rtc/offer bun test/rtc-frame.mjs 20   连远端（会在对方机器开一个房间）
import { signUrl } from './rtc-node.mjs';
import { NetCore } from '../shared/session.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel, placeOnGrid } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECS = Number(process.argv[2] || 8);
const REMOTE = (process.env.REMOTE_SIGN || '').trim();
const PORT_FILE = ROOT + '.tmp/rtc-frame-port';

let port = 0, child = null;
if (REMOTE) {
  port = Number(REMOTE.match(/https?:\/\/[^:]+:(\d+)/)?.[1] || 8790);
} else {
  try { await Bun.write(PORT_FILE, ''); } catch {}
  child = Bun.spawn([process.execPath, 'server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, ADMIN_TOKEN: 'k' },
    stdout: 'ignore', stderr: 'ignore',
  });
  for (let i = 0; i < 100 && !port; i++) {
    const s = (await Bun.file(PORT_FILE).text()).trim();
    if (s) port = Number(s); else await Bun.sleep(50);
  }
  if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }
}
const http = `http://${REMOTE ? new URL(REMOTE).host : 'localhost:' + port}`;

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
// 让车持续变道：预测与权威的偏差在转向时才成量，直道两秒不动的话 A/B 看不出差别
const w0 = performance.now();
const steer = (car) => {
  const wob = 2.6 * Math.sin((performance.now() - w0) / 620);
  const s = track.sample(car.d + 22, {});
  const gx = s.x + (s.rx || 0) * wob, gz = s.z + (s.rz || 0) * wob;
  const e = ((Math.atan2(gx - car.x, gz - car.z) - car.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return { up: true, down: false, left: e > 0.03, right: e < -0.03, shift: false, upPressed: false, wPressed: false, nitroPressed: false };
};

const sign = REMOTE || signUrl(port);
const nets = [];
for (let i = 0; i < 2; i++) {
  const car = new PlayerCar(track, stubModel(), `车${i}`);
  placeOnGrid(car, 0);
  const net = new NetCore({ url: sign, name: `车${i}`, skin: i, map: 'city', laps: 2, mode: 0, diff: 1, create: i === 0, code: '', track, ownCar: car });
  net.frames = [];      // 每帧耗时
  net.offsets = [];     // 每帧的视觉偏差（正在偿还的横向距离）
  net.cuts = 0;
  net.glides = 0;       // 本帧处于滑行状态
  net.inj = [];         // 每次对账注入了多大的偏差（分开看"单笔"与"注入后的总量"）
  net.speeds = [];      // 每帧被修正拽回去的位移速度 m/s（>9 就说明滑速超过了设计上限）
  net.lat = [];         // 渲染位姿的横向速度（眼睛真正看得到的那部分）
  net.fwd = [];         // 渲染位姿的纵向速度
  const sv = net.setVisual.bind(net);
  net.setVisual = (dx, dz, dh) => {
    const before = Math.hypot(dx, dz);
    sv(dx, dz, dh);
    net.inj.push([+before.toFixed(2), +(Math.hypot(net.visual.x, net.visual.z) * net.visual.t).toFixed(2)]);
    if (before > 3) (net.big ||= []).push(`偏差 ${before.toFixed(1)}m @tick ${net.tick}（ack ${net.lastAck}，领先 ${(net.tick - net.lastAck).toFixed(0)} tick）· 相位 ${net.phase} · 车速 ${(net.me?.s || 0).toFixed(1)} · 第 ${net.snapCount} 份快照`);
  };
  nets.push(net);
}
const t0 = Date.now();
while (Date.now() - t0 < 8000 && !nets.every((n) => n.roster.length >= 2)) {
  for (const n of nets) n.step(16, steer(n.me), false);
  await Bun.sleep(16);
}
const code = nets[0].code;
for (const n of nets) n.ready(true);
await Bun.sleep(200);
// 远端那台机器的后台令牌不是我们的：让它自己按"邀请窗口 5s + 倒计时 3s"开赛
if (!REMOTE) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${http}/api/admin/rooms/${code}/start?key=k`, { method: 'POST' });
    if (r.ok) break;
    await Bun.sleep(150);
  }
}
for (let i = 0; i < (REMOTE ? 550 : 200) && nets.some((n) => n.phase < 2); i++) { for (const n of nets) n.step(16, steer(n.me), false); await Bun.sleep(30); }
if (nets.some((n) => n.phase < 2)) { console.log(`FAIL 没能进入比赛（相位 ${nets.map((n) => n.phase)}）· 房间 ${code}`); process.exit(1); }

const h0 = await (await fetch(`${http}/healthz`)).json();
const wall0 = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  for (const n of nets) {
    const since = now - (n.lastFrame || wall0);
    n.lastFrame = now;
    n.frames.push(since);
    const before = n.hardSnap;
    n.step(16, steer(n.me), n.phase >= 2 && !n.me.finished);
    n.syncPose(0.016); // 渲染位姿只有 syncPose 会算，不调它等于没测
    if (n.hardSnap && !before) n.cuts++;
    const v = n.visual;
    if (v && v.t > 0) { n.glides++; n.offsets.push(Math.hypot(v.x, v.z) * v.t); }
    // 眼睛看的是渲染位姿：把这一帧 rx/rz 的位移拆成"沿行驶方向"和"横向"。
    // 纵向是车本来就在跑，横向才是修正造成的滑动/抖动。
    const c = n.me;
    if (c && c.rx !== undefined && n.prevRx !== undefined) {
      const mx = c.rx - n.prevRx, mz = c.rz - n.prevRz;
      const ux = Math.sin(c.h), uz = Math.cos(c.h);
      n.lat.push(Math.abs(-mx * uz + mz * ux) / 0.016);
      n.fwd.push((mx * ux + mz * uz) / 0.016);
    }
    n.prevRx = c?.rx; n.prevRz = c?.rz;
    // 修正带来的那部分位移：单位时间走掉多少偏移，就是玩家眼里"车被拽回去"的速度
    const off = v && v.t > 0 ? { x: v.x * v.t, z: v.z * v.t } : { x: 0, z: 0 };
    if (n.prevOff) n.speeds.push(Math.hypot(off.x - n.prevOff.x, off.z - n.prevOff.z) / 0.016);
    n.prevOff = off;
  }
}, 16);
await Bun.sleep(SECS * 1000);
clearInterval(loop);
const secs = (performance.now() - wall0) / 1000;
const h1 = await (await fetch(`${http}/healthz`)).json();

const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : 0; };
for (const n of nets) {
  const f = n.frames.slice(20);
  const lat = n.lat.slice(90), fwd = n.fwd.slice(90);
  const sp = n.speeds.slice(90);
  const offs = n.offsets.slice(90);
  const single = n.inj.slice(30).map((p) => p[0]);
  const merged = n.inj.slice(30).map((p) => p[1]);
  const over = f.filter((x) => x > 60).length;
  const worst = f.length ? Math.max(...f).toFixed(0) : 0;
  const deep = offs.filter((x) => x > 2).length;
  console.log(`${n.me.name}：${(f.length / secs).toFixed(1)} 帧/秒 · 帧时 中位 ${pctl(f, 0.5)}ms p95 ${pctl(f, 0.95)}ms 最坏 ${worst}ms · >60ms 的帧 ${over}`);
  console.log(`  渲染横向速度（眼睛看到的）：中位 ${pctl(lat, 0.5)}m/s p95 ${pctl(lat, 0.95)}m/s 最坏 ${(lat.length ? Math.max(...lat) : 0).toFixed(1)}m/s · >9m/s 的帧 ${lat.filter((x) => x > 9).length} · >20m/s 的帧 ${lat.filter((x) => x > 20).length}（纵向车速中位 ${pctl(fwd, 0.5)}m/s 作对照）`);
  console.log(`  对账注入 ${n.inj.length} 次：单笔 中位 ${pctl(single, 0.5)}m p95 ${pctl(single, 0.95)}m 最大 ${single.length ? Math.max(...single) : 0}m · 偿还中的偏移峰值 ${offs.length ? Math.max(...offs).toFixed(1) : 0}m · >2m 的帧 ${deep}`);
  console.log(`  滑行中的帧 ${n.glides}（占 ${(n.glides / Math.max(1, n.frames.length) * 100).toFixed(0)}%）· 硬切 ${n.cuts} 次 · 回滚 ${n.rolls}`);
  for (const b of n.big || []) console.log(`    ! ${b}`);
}
const d = h1.rtc.sentFrames - h0.rtc.sentFrames, dk = h1.rtc.sentKb - h0.rtc.sentKb, dd = h1.rtc.fastDropped - h0.rtc.fastDropped;
console.log(`服务器增量（${secs.toFixed(1)}s）：发出 ${d} 帧 ${dk}KB（${(d / secs).toFixed(1)} 帧/秒）· 背压丢弃 ${dd} · 在线 ${h1.rtc.peers}`);
console.log(d < nets.length * secs * 20 * 0.9 ? `注意：服务器发出的快照帧数低于 20Hz×人数，服务端本身没跑满` : '服务器出帧正常（≈20Hz/人）');
for (const n of nets) { n.leave(); n.dispose(); }
if (child) child.kill();
process.exit(0);
