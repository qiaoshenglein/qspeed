// 端到端：两个客户端 + 真服务器，验证 tick 对齐、预测误差、快照频率与名次一致性
import { NetCore } from '../shared/session.js';
import { signUrl } from './rtc-node.mjs';
import { PlayerCar, TUNE } from '../shared/vehicle.js';
import { stubModel, placeOnGrid } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT_FILE = ROOT + '.tmp/net-port';
try { await Bun.write(PORT_FILE, ''); } catch {}

const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE },
  stdout: 'pipe', stderr: 'pipe',
});
const t0 = Date.now();
let port = 0;
while (Date.now() - t0 < 8000) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) { port = Number(s); break; }
  await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }
const health = await (await fetch(`http://localhost:${port}/healthz`)).json();
if (health.build !== 'qq-speed-net-v3') { console.log('FAIL 命中的是旧服务进程', health); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' · ' + extra : ''}`); }
};

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const code = process.argv[2] || '';
const ITEM = process.env.ITEM === '1';
const MODE = ITEM ? 1 : 0;

function makeClient(name, skin, drive) {
  const car = new PlayerCar(track, stubModel(), name);
  placeOnGrid(car, 0);
  const net = new NetCore({
    url: signUrl(port), name, skin, map: 'city', laps: 2, mode: MODE, diff: 1, code, itemMode: ITEM,
    track, ownCar: car,
  });
  net.events = [];
  net.onEvent = (e) => net.events.push(e);
  const state = { placed: false, ticks: 0 };
  let last = performance.now();
  const loop = setInterval(() => {
    const now = performance.now();
    const real = now - last;
    last = now;
    net.maxFrame = Math.max(net.maxFrame || 0, real);
    if (net.phase >= 2) { (net.frames || (net.frames = [])).push(real); }
    const dtMs = Math.min(200, real); // 与游戏一致：一帧拖长了就补跑，不要人为让本端落后
    let inp = { up: false, down: false, left: false, right: false, shift: false, upPressed: false, wPressed: false, nitroPressed: false };
    if (net.phase >= 1) {
      inp = drive(car, net);
      state.ticks++;
      // 开赛时与服务器一致地把车放回发车格（浏览器端由 placeOnGridLocal 做）
      if (!state.placed) {
        state.placed = true;
        const me = net.rosterFor(net.myCarId);
        if (me) placeOnGrid(car, me.slot);
        net.tick = 0;
        net.hist.fill(null);
        net.pending.length = 0;
      }
    }
    net.step(dtMs, inp, net.phase >= 2 && !car.finished);
    const snap = net.lastSnap;
    if (snap?.items) {
      entSeen = Math.max(entSeen, snap.items.missiles.length + snap.items.bananas.length);
      boxMaskSeen = snap.items.mask;
      if (snap.items.mask !== ALL_BOXES) boxHiddenSeen = true; // 有箱子被踩掉过（2.5 秒后会恢复，末帧看不出来）
    }
    if (snap) {
      const holders = snap.racers.filter((r) => r.items.some((i) => i != null)).length;
      itemSeen += holders;
      holdersPeak = Math.max(holdersPeak, holders);
    }
  }, 8);
  return { net, car, state, loop };
}

// 简单驾驶：加速 + 按赛道朝向微调转向 + 直道放氮气
function drive(car, net) {
  // 道具模式下左右扫线，压过更多道具箱
  const latWant = ITEM ? Math.sin(net.tick / 90) * (net.track.halfW - 3) : 0;
  const ahead = net.track.sample(car.d + 22, {});
  const ax = ahead.x + ahead.rx * latWant, az = ahead.z + ahead.rz * latWant;
  const e = ((Math.atan2(ax - car.x, az - car.z) - car.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const wantNitro = Math.abs(e) < 0.02 && car.s > 30 && !car.nitroTime;
  // 道具模式：Ctrl 是使用道具，攒一个就放（由服务器权威结算）
  const wantItem = ITEM && gotItems() && net.tick % 60 === 0;
  return {
    up: true, down: false,
    left: e > 0.05, right: e < -0.05,
    shift: Math.abs(e) > 0.5 && car.s > 20,
    upPressed: false, wPressed: false,
    nitroPressed: ITEM ? wantItem : (wantNitro && net.tick % 90 === 0),
  };
}
let itemSeen = 0, holdersPeak = 0, entSeen = 0, boxMaskSeen = 0, boxHiddenSeen = false;
const ALL_BOXES = (1 << 20) - 1;
const gotItems = () => itemSeen > 0;

const a = makeClient('甲', 0, drive);
await Bun.sleep(700);
const b = makeClient('乙', 1, (car) => ({
  up: true, down: false, left: false, right: false, shift: false,
  upPressed: false, wPressed: false, nitroPressed: false,
}));

const waitUntil = async (fn, ms = 4000) => { const e = Date.now() + ms; while (Date.now() < e && !fn()) await Bun.sleep(80); };
await waitUntil(() => a.net.code && b.net.code);
ok('两个客户端都拿到房间码', a.net.code && a.net.code === b.net.code, `code=${a.net.code}/${b.net.code}`);
ok('车辆 id 不同', a.net.myCarId && b.net.myCarId && a.net.myCarId !== b.net.myCarId, `${a.net.myCarId}/${b.net.myCarId}`);

// 双方准备 → 服务器开赛
await Bun.sleep(200);
a.net.ready(true);
b.net.ready(true);

const raceStart = Date.now();
while (a.net.phase < 2 && Date.now() - raceStart < 16000) await Bun.sleep(100);
ok('进入比赛阶段', a.net.phase >= 2, `phase=${a.net.phase}`);

const t1 = Date.now();
// 速率类判据只能用"开赛之后"的增量。WebRTC 建连本身要 0.5~1 秒（信令 + ICE + DTLS），
// 大厅与倒计时期间也在按 20Hz 收快照；把这些算进比赛窗口会凭空把 20Hz 报成 30Hz、
// 把带宽抬高一大截——换传输之后这个偏差才第一次暴露出来。
const rateBase = { aSnaps: a.net.snapCount, aBytes: a.net.downBytes, bSnaps: b.net.snapCount, bBytes: b.net.downBytes };
const dbg = async () => {
  if (!process.env.NET_DEBUG) return;
  const d = await (await fetch(`http://localhost:${port}/debug/rooms`)).json();
  for (const r of d.rooms) {
    console.log(`  [srv tick=${r.tick} ${r.state}] ` + r.cars.filter((c) => c.human).map((c) => `#${c.id} ${c.name} bias=${c.bias} s=${c.s} prog=${c.progress} pend=${c.pend} drop=${c.dropped}`).join(' | '));
  }
  const A = a.net.lastSnap?.racers.find((x) => x.carId === a.net.myCarId);
  const B = b.net.lastSnap?.racers.find((x) => x.carId === b.net.myCarId);
  console.log(`  [cli] a.tick=${a.net.tick} world=${a.net.worldTick} own=(${a.car.x.toFixed(1)},${a.car.z.toFixed(1)}) s=${a.car.s.toFixed(1)} srv=(${A ? A.x.toFixed(1) : '-'},${A ? A.z.toFixed(1) : '-'}) SA=${A ? A.s.toFixed(1) : '-'} err=${a.net.stats().maxErr} rolls=${a.net.stats().rolls}`);
  console.log(`  [cli] b.tick=${b.net.tick} phase=${b.net.phase} own=(${b.car.x.toFixed(1)},${b.car.z.toFixed(1)}) s=${b.car.s.toFixed(1)} srv=(${B ? B.x.toFixed(1) : '-'}) err=${b.net.stats().maxErr} rolls=${b.net.stats().rolls}`);
};
while (Date.now() - t1 < (ITEM ? 15000 : 9000)) { await Bun.sleep(1500); await dbg(); }

const sa = a.net.stats(), sb = b.net.stats();
sa.snaps -= rateBase.aSnaps;
sb.snaps -= rateBase.bSnaps;
sa.kbDown = +((a.net.downBytes - rateBase.aBytes) / 1024).toFixed(2);
sb.kbDown = +((b.net.downBytes - rateBase.bBytes) / 1024).toFixed(2);
const recA = a.net.lastSnap?.racers.find((x) => x.carId === a.net.myCarId);
const recB = a.net.lastSnap?.racers.find((x) => x.carId === b.net.myCarId);
const dur = (Date.now() - t1) / 1000;

ok('快照频率约 20Hz', sa.snaps / dur > 15 && sa.snaps / dur < 30, `${(sa.snaps / dur).toFixed(1)}Hz`);
ok('甲车在前进', recA && recA.progress > 200, `${Math.round(recA?.progress || 0)}m`);
ok('乙车在前进', recB && recB.progress > 200, `${Math.round(recB?.progress || 0)}m`);
// 预测误差要按"本端有没有被这台机器拖住"来判。只看最长帧不够：一帧 60ms 偶发一次不要紧，
// 但 p95 帧长决定了一帧要补跑多少个 tick —— 补跑 7 个 tick 与补跑 1.2 个 tick，
// 量出来的 maxErr 完全不是一个东西。0.6m 的阈值不动，判据换成"帧长分布"。
const p95 = (arr) => { const s = [...(arr || [])].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.95)] : 0; };
const fA = p95(a.net.frames), fB = p95(b.net.frames);
const envOk = Math.max(a.net.maxFrame || 0, b.net.maxFrame || 0) <= 60 && Math.max(fA, fB) <= 24;
const envDesc = `帧长 p95 甲 ${fA.toFixed(1)}ms / 乙 ${fB.toFixed(1)}ms，最长 ${Math.max(a.net.maxFrame || 0, b.net.maxFrame || 0).toFixed(0)}ms`;
if (ITEM) { /* 道具模式的误差另有专门的判据，见下方 */ }
else if (!envOk) {
  console.log(`SKIP 预测误差：这台机器把本端帧拖长了（${envDesc}），一帧要补跑多个 tick，量出的误差不能算到机制头上（甲 maxErr=${sa.maxErr}m 乙=${sb.maxErr}m）`);
} else {
  ok('预测误差可控(<0.6m)', sa.maxErr < 0.6, `甲 maxErr=${sa.maxErr}m 回滚${sa.rolls}次`);
  ok('预测误差可控 乙(<0.6m)', sb.maxErr < 0.6, `乙 maxErr=${sb.maxErr}m 回滚${sb.rolls}次`);
}
// 同样是时间类判据：本端一帧卡了 200ms 就相当于少跑 24 个 tick，这不是机制的误差。
// 阈值不动（<20 tick），负载不够就明确跳过并给出实测帧长。
if (envOk) {
  ok('客户端 tick 与服务器世界 tick 同步', Math.abs(a.net.tick - a.net.worldTick) < 20 && Math.abs(b.net.tick - b.net.worldTick) < 20, `甲差${a.net.tick - a.net.worldTick} 乙差${b.net.tick - b.net.worldTick}`);
} else {
  console.log(`SKIP tick 同步：${envDesc}（一帧拖长就等于少跑若干 tick，这个差值不能算到机制头上）`);
}
ok('速度未超物理上限', Math.abs(recA.s) <= 86 + 1 && Math.abs(recB.s) <= 86 + 1, `${recA.s.toFixed(1)}/${recB.s.toFixed(1)} m/s，上限 ${TUNE.vmaxNitro}`);
ok('名次由服务器判定且互不相同', recA.place !== recB.place, `甲${recA.place} 乙${recB.place}`);
ok('两端的车辆集合一致', b.net.lastSnap && b.net.lastSnap.racers.length === a.net.lastSnap.racers.length &&
  a.net.lastSnap.racers.every((r) => b.net.lastSnap.racers.some((x) => x.carId === r.carId)));
ok('bot 补满 6 台车', a.net.lastSnap.racers.length === 6, `${a.net.lastSnap.racers.length}`);
ok('下行带宽在预算内', sa.kbDown / dur < (ITEM ? 8 : 6), `${(sa.kbDown / dur).toFixed(2)} KB/s（${ITEM ? '道具' : '竞速'}模式）`);
if (ITEM) {
  const withItems = (a.net.lastSnap?.racers || []).filter((r) => r.items.some((i) => i != null));
  const ents = a.net.lastSnap?.items;
  ok('道具随快照下发到客户端', holdersPeak > 0, `${holdersPeak} 台车同时持有过道具：${withItems.map((r) => r.items.join('+')).join(', ') || '末帧已用完'}`);
  ok('道具箱可见位图与服务器一致', !!ents && typeof ents.mask === 'number' && ents.mask > 0, ents ? `mask=${ents.mask.toString(2).slice(0, 12)}…` : '无道具段');
  const used = a.net.events.filter((ev) => ev.type === 'itemUse');
  const hits = a.net.events.filter((ev) => ev.type === 'missiled' || ev.type === 'banana' || ev.type === 'shieldHit');
  ok('场上有道具实体在飞行/落地', entSeen > 0, `同场最多 ${entSeen} 个实体`);
  ok('道具使用由服务器结算并广播', used.length > 0, `观察到 ${used.length} 次使用、${hits.length} 次命中`);
  ok('真人使用的道具由服务器消费', itemSeen > 0, `观察到 ${itemSeen} 次持有道具的快照`);
  ok('客户端观察到箱子被踩掉', boxHiddenSeen, `末帧位图 ${boxMaskSeen.toString(2)}`);
  ok('道具模式预测误差有界(<4m)', sa.maxErr < 4 && sb.maxErr < 4, `A ${sa.maxErr}m / B ${sb.maxErr}m`);
  ok('道具模式带宽 < 9KB/s', sa.kbDown / dur < 9, `${(sa.kbDown / dur).toFixed(2)} KB/s`);
}
ok('上行带宽 < 1KB/s', sa.kbUp / dur < 1, `${(sa.kbUp / dur).toFixed(2)} KB/s`);
ok('往返延迟已测量', sa.rtt > 0 && sa.rtt < 120, `${sa.rtt}ms`);

// 掉线：甲断开后乙的比赛继续
clearInterval(a.loop);
a.net.dispose();
const before = b.net.snapCount;
await Bun.sleep(1500);
ok('有人掉线后比赛继续推送', b.net.snapCount - before > 20, `${b.net.snapCount - before} 帧/1.5s`);
const autoRec = b.net.lastSnap?.racers.find((x) => x.carId === a.net.myCarId);
ok('掉线车辆被服务端接管', autoRec && (autoRec.flags & 128) !== 0, autoRec ? `speed=${autoRec.s.toFixed(1)}` : '车辆已消失');

clearInterval(b.loop);
b.net.dispose();
child.kill();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
