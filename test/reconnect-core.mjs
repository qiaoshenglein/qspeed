// 客户端栈（NetCore）自动回线：断线后应凭席位令牌重连、找回同一车位并续上快照
import { NetCore } from '../shared/session.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel, placeOnGrid } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT_FILE = ROOT + '.tmp/reconnect-port';
try { await Bun.write(PORT_FILE, ''); } catch {}
const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, GHOST_RACE_MS: '30000' },
  stdout: 'ignore', stderr: 'ignore',
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
if (health.build !== 'qq-speed-net-v1') { console.log('FAIL 命中的是旧服务进程', health); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}${x ? ' · ' + x : ''}`)) : (fail++, console.log(`FAIL ${n}${x ? ' · ' + x : ''}`)); };
const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const roomsHttp = async () => (await (await fetch(`http://localhost:${port}/rooms`)).json()).rooms;

function makeClient(name, over = {}) {
  const car = new PlayerCar(track, stubModel(), name);
  placeOnGrid(car, 0);
  const net = new NetCore({
    url: `ws://localhost:${port}/ws`, name, skin: 0, map: 'city', laps: 2, mode: 0, diff: 1,
    code: '', create: true, track, ownCar: car, ...over,
  });
  net.events = [];
  net.onEvent = (e) => net.events.push(e);
  const st = { last: performance.now() };
  net.loop = setInterval(() => {
    const now = performance.now();
    const dtMs = Math.min(50, now - st.last);
    st.last = now;
    net.step(dtMs, { up: true, down: false, left: false, right: false, shift: false, upPressed: false, wPressed: false, nitroPressed: false }, net.phase >= 1);
  }, 8);
  return net;
}

const a = makeClient('甲');
await Bun.sleep(800);
ok('创建房间并拿到席位令牌', !!a.token && /^[A-Z0-9]{4}$/.test(a.code || ''), `code=${a.code} car=${a.myCarId}`);
const carId = a.myCarId;
const b = makeClient('乙', { code: a.code, create: false });
await Bun.sleep(800);
ok('第二名玩家加入同一房间', b.code === a.code && b.myCarId !== carId, `${b.code} car=${b.myCarId}`);
ok('房间在公开列表里', (await roomsHttp()).some((r) => r.code === a.code && r.players === 2), JSON.stringify(await roomsHttp()));

a.ready(true);
b.ready(true);
for (let i = 0; i < 40 && !(a.phase >= 2 && a.snapCount > 10); i++) await Bun.sleep(300);
ok('全员准备后自动开赛并持续收快照', a.phase >= 2 && a.snapCount > 10, `phase=${a.phase} snaps=${a.snapCount}`);

// 断线 → 客户端自动回线
const before = a.snapCount;
a.ws.close();
for (let i = 0; i < 20 && !(a.connected && a.snapCount > before + 10); i++) await Bun.sleep(300);
const rec = a.lastSnap ? a.lastSnap.racers.find((r) => r.carId === a.myCarId) : null;
const derr = rec ? Math.hypot(a.me.x - rec.x, a.me.z - rec.z) : 1e9;
ok('断线后自动重连成功', a.connected === true && a.reconns === 0, `connected=${a.connected} reconns=${a.reconns}`);
ok('回线拿回同一个车位', a.myCarId === carId, `${carId} → ${a.myCarId}`);
ok('回线后快照继续增长', a.snapCount > before + 10, `${before} → ${a.snapCount}`);
ok('回线后本车对齐到服务器位置', derr < 8, `偏差 ${derr.toFixed(2)}m`);
ok('回线过程不产生新席位', (await roomsHttp()).find((r) => r.code === a.code)?.players === 2, `players=${(await roomsHttp()).find((r) => r.code === a.code)?.players}`);
ok('回线后继续收到比赛事件', a.events.length > 0, `${a.events.length} 条`);

const d = (await (await fetch(`http://localhost:${port}/debug/rooms`)).json()).rooms.find((r) => r.code === a.code);
const mine = d && d.cars.find((c) => c.id === carId);
ok('回线后服务器交还驾驶权', !!mine && mine.auto === false, mine && `auto=${mine.auto} speed=${mine.s}`);

clearInterval(a.loop);
clearInterval(b.loop);
a.dispose();
b.dispose();
child.kill();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
