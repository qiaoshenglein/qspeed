// 渲染平滑度测量：用真实服务器 + 真实客户端栈，按 60Hz 定步长采样"最终渲染位姿"序列，
// 计算抖动指标（ jerk / 方向反转 / 单帧跳变 ）。这里测的是机制，不是这台慢机器的帧率。
import { NetCore, INTERP_DELAY_MS } from '../shared/session.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel, placeOnGrid, DT } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT_FILE = ROOT + '.tmp/smooth-port';
try { await Bun.write(PORT_FILE, ''); } catch {}
const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE },
  stdout: 'ignore', stderr: 'ignore',
});
let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) port = Number(s); else await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }
const health = await (await fetch(`http://localhost:${port}/healthz`)).json();
if (health.build !== 'qq-speed-net-v1') { console.log('FAIL 命中的是旧服务进程', health); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}${x ? ' · ' + x : ''}`)) : (fail++, console.log(`FAIL ${n}${x ? ' · ' + x : ''}`)); };

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const FRAME_MS = 1000 / 60;

function makeClient(name, skin, over = {}) {
  const car = new PlayerCar(track, stubModel(), name);
  placeOnGrid(car, 0);
  const net = new NetCore({
    url: `ws://localhost:${port}/ws`, name, skin, map: 'city', laps: 2, mode: 0, diff: 1,
    code: '', create: true, track, ownCar: car, ...over,
  });
  net.traceOwn = [];
  net.traceRemote = [];
  net.remotePick = null;
  return net;
}

// 本端最终渲染位置：新实现走 syncPose（渲染位姿是唯一来源），旧实现复刻 net.js 的"物理 + 衰减偏移"
function ownRendered(net, dtS) {
  if (net.syncPose) {
    net.syncPose(dtS);
    return { x: net.me.rx, z: net.me.rz };
  }
  const v = net.visual;
  return { x: net.me.x + (v.t > 0 ? v.x : 0), z: net.me.z + (v.t > 0 ? v.z : 0) };
}
// 他车最终渲染位置：新实现走服务器 tick 时钟，旧实现按到达时刻插值
function remoteRendered(net, dtS) {
  if (!net.remotePick) {
    for (const [id, st] of net.remote) if (id !== net.myCarId && st.cur) { net.remotePick = id; break; }
    if (!net.remotePick) return null;
  }
  const st = net.remote.get(net.remotePick);
  if (!st || !st.cur) return null;
  const s = net.interpState(st, net.renderTick ? net.renderTick() : performance.now() - INTERP_DELAY_MS);
  return s ? { x: s.x, z: s.z } : null;
}

function drive(car) {
  const s = track.sample(car.d + 22, {});
  const e = ((Math.atan2(s.x - car.x, s.z - car.z) - car.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return { up: true, down: false, left: e > 0.03, right: e < -0.03, shift: Math.abs(e) > 0.4 && car.s > 20, upPressed: false, wPressed: false, nitroPressed: false };
}

const a = makeClient('甲', 0);
await Bun.sleep(500);
// 另外两名真人加入同一房间：制造真实的相互碰撞与到达成帧抖动
const b = makeClient('乙', 1, { code: a.code, create: false });
const bb = makeClient('丙', 2, { code: a.code, create: false });
await Bun.sleep(500);
a.ready(true);
b.ready(true);
bb.ready(true);
await Bun.sleep(9000); // 邀请窗口 5s + 倒计时 3s

const dtS = FRAME_MS / 1000;
const loop = setInterval(() => {
  for (const c of [a, b, bb]) {
    c.step(FRAME_MS, drive(c.me), c.phase >= 2 && !c.me.finished);
    if (c === a) {
      const p = ownRendered(c, dtS);
      c.traceOwn.push(p);
      const r = remoteRendered(c, dtS);
      if (r) c.traceRemote.push(r);
    }
  }
}, FRAME_MS);
await Bun.sleep(9000);
clearInterval(loop);

// 抖动指标：二阶差分（jerk）、方向反转帧、单帧位移突刺
function stats(tr, expectStep) {
  if (tr.length < 5) return null;
  let jerk = 0, maxJerk = 0, rev = 0, spike = 0, stepSum = 0, maxStep = 0, n = 0, steps = 0;
  for (let i = 1; i < tr.length; i++) {
    const dx = tr[i].x - tr[i - 1].x, dz = tr[i].z - tr[i - 1].z;
    const st = Math.hypot(dx, dz);
    steps++; stepSum += st;
    maxStep = Math.max(maxStep, st);
    if (i >= 2) {
      const pdx = tr[i - 1].x - tr[i - 2].x, pdz = tr[i - 1].z - tr[i - 2].z;
      const j = Math.hypot(dx - pdx, dz - pdz);
      jerk += j; maxJerk = Math.max(maxJerk, j); n++;
      if (dx * pdx + dz * pdz < -1e-6) rev++;
    }
    if (st > expectStep * 3) spike++;
  }
  const meanStep = stepSum / Math.max(1, steps);
  return { frames: tr.length, meanJerk: +(jerk / Math.max(1, n)).toFixed(4), maxJerk: +maxJerk.toFixed(3), reversals: rev, spikes: spike, meanStep: +meanStep.toFixed(3), maxStep: +maxStep.toFixed(2), ratio: +(maxStep / Math.max(0.001, meanStep)).toFixed(2) };
}

const VA = a.traceOwn.length, VB = a.traceRemote.length;
ok('采到了足够帧', VA > 300 && VB > 300, `本车 ${VA} 帧 / 他车 ${VB} 帧 · 服务器 tick ${a.worldTick}`);
// 车速约 50m/s → 60Hz 每帧约 0.85m
const own = stats(a.traceOwn, 0.85);
const rem = stats(a.traceRemote, 0.85);
console.log('本车渲染轨迹:', JSON.stringify(own));
console.log('他车渲染轨迹:', JSON.stringify(rem));
ok('本车无单帧位移突刺(>3 帧步长)', own.spikes <= 3, `突刺 ${own.spikes} 帧 / 最大单帧 ${own.maxStep}m`);
ok('本车平均抖动足够小', own.meanJerk < 0.05, `meanJerk ${own.meanJerk} · max ${own.maxJerk}`);
ok('本车方向不反复', own.reversals <= 3, `反转 ${own.reversals} 帧`);
ok('他车无单帧位移突刺', rem.spikes <= 3, `突刺 ${rem.spikes} 帧 / 最大单帧 ${rem.maxStep}m`);
ok('他车平均抖动足够小', rem.meanJerk < 0.05, `meanJerk ${rem.meanJerk} · max ${rem.maxJerk}`);
ok('他车方向不反复', rem.reversals <= 5, `反转 ${rem.reversals} 帧`);

for (const c of [a, b, bb]) c.dispose();
child.kill();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
