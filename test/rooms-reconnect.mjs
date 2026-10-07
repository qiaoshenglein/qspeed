// 房间列表 + 断线重连：真服务器、真 WebSocket，验证席位令牌与公开列表语义
import { C, S, PHASE, Writer, Reader, decodeRoster, decodeSnapshot } from '../shared/proto.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT_FILE = ROOT + '.tmp/rooms-port';
try { await Bun.write(PORT_FILE, ''); } catch {}

const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT,
  // 席位宽限期在测试里压缩到 3 秒，方便验证过期回收
  env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, GHOST_RACE_MS: '3000', GHOST_LOBBY_MS: '3000' },
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
if (health.build !== 'qq-speed-net-v1') { console.log('FAIL 命中的是旧服务进程', health); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' · ' + extra : ''}`); }
};

const base = { name: '车手', skin: 1, map: 'city', laps: 2, mode: 0, diff: 1, code: '', create: 0, token: '' };
function helloBytes(o) {
  const w = new Writer(160);
  w.u8(C.HELLO).u8(1).str(o.name).u8(o.skin).str(o.map).u8(o.laps).u8(o.mode).u8(o.diff)
    .str(o.code || '').u8(o.create ? 1 : 0).str(o.token || '');
  return w.bytes();
}
function readyBytes(on) { const w = new Writer(4); w.u8(C.READY).u8(on ? 1 : 0); return w.bytes(); }

class Cli {
  constructor(over = {}) {
    this.opts = { ...base, ...over };
    this.snaps = 0;
    this.phase = -1;
    this.err = '';
    this.raw = [];
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((res) => { this.ws.onopen = res; });
    this.ws.onmessage = (e) => this.onMsg(e.data);
    this.closed = new Promise((res) => { this.closedResolve = res; });
    this.ws.onclose = () => this.closedResolve();
  }
  onMsg(buf) {
    const b = new Uint8Array(buf);
    const r = new Reader(b);
    const type = r.u8();
    this.raw.push(type);
    if (type === S.WELCOME) {
      this.welcome = { carId: r.u16(), code: r.str(), mapId: r.str(), laps: r.u8(), mode: r.u8(), phase: r.u8(), tick: r.u32() };
      r.u32(); r.u8(); r.u8(); r.u32(); // seed / grid / snapHz / elapsed
      if (!r.eof) this.token = r.str();
      this.phase = this.welcome.phase;
    } else if (type === S.ROSTER) {
      const { extra, list } = decodeRoster(r);
      this.roster = list;
      this.phase = extra;
    } else if (type === S.SNAP) {
      const snap = decodeSnapshot(r);
      this.snaps++;
      this.phase = snap.phase;
      this.snap = snap;
    } else if (type === S.ERR) {
      this.err = r.str();
    } else if (type === S.RESULT) this.phase = PHASE.result;
  }
  async send(bytes) {
    await this.opened;
    this.ws.send(bytes);
  }
  hello(over) { Object.assign(this.opts, over); return this.send(helloBytes(this.opts)); }
  ready(on = true) { return this.send(readyBytes(on)); }
  async until(pred, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await Bun.sleep(30);
    }
    return false;
  }
  kill() { try { this.ws.close(); } catch { /* 已断 */ } }
}

const rooms = async () => (await (await fetch(`http://localhost:${port}/rooms`)).json()).rooms;
const debug = async () => (await (await fetch(`http://localhost:${port}/debug/rooms`)).json()).rooms;

// ---------- 1. 创建与列表 ----------
const A = new Cli({ name: '甲' });
await A.hello({ create: 1, map: 'city', laps: 2, mode: 0 });
await A.until(() => A.welcome);
ok('创建房间拿到房间码与席位令牌', !!A.welcome && /^[A-Z0-9]{4}$/.test(A.welcome.code) && !!A.token, `code=${A.welcome?.code} token=${(A.token || '').slice(0, 6)}…`);

let list = await rooms();
const row = list.find((r) => r.code === A.welcome.code);
ok('新房间出现在公开列表', !!row && row.listed === true && row.players === 1, JSON.stringify(row));
ok('列表带地图/圈数/模式/上限', !!row && row.mapName.length > 0 && row.laps === 2 && row.mode === 0 && row.cap === 6, row && `${row.mapName} ${row.laps}圈 ${row.mode} ${row.players}/${row.cap}`);

const B = new Cli({ name: '乙' });
await B.hello({ code: A.welcome.code });
await B.until(() => B.welcome);
ok('凭房间码自由加入', !!B.welcome && B.welcome.code === A.welcome.code && B.welcome.carId !== A.welcome.carId, `${B.welcome?.code} car=${B.welcome?.carId}`);
list = await rooms();
ok('列表人数随加入增长', list.find((r) => r.code === A.welcome.code)?.players === 2, `players=${list.find((r) => r.code === A.welcome.code)?.players}`);

const wrong = new Cli({ name: '丙' });
await wrong.hello({ code: A.welcome.code, map: 'aegean' });
await wrong.until(() => wrong.err);
ok('设置不符时服务器拒绝并入列原因', /地图/.test(wrong.err), wrong.err);

// ---------- 2. 大厅掉线 → 令牌回线 ----------
const carIdA = A.welcome.carId;
A.kill();
await A.closed;
await Bun.sleep(120);
list = await rooms();
ok('掉线后席位仍保留', list.find((r) => r.code === A.welcome.code)?.players === 2, `players=${list.find((r) => r.code === A.welcome.code)?.players}`);
await B.until(() => (B.roster || []).some((p) => p.online === false));
ok('在线名单标出掉线席位', (B.roster || []).some((p) => p.online === false), JSON.stringify((B.roster || []).map((p) => `${p.name}:${p.online ? 'on' : 'off'}`)));

const A2 = new Cli({ name: '甲' });
await A2.hello({ code: A.welcome.code, token: A.token });
await A2.until(() => A2.welcome);
ok('凭令牌回线拿回同一个车位', A2.welcome?.carId === carIdA, `旧 ${carIdA} → 新 ${A2.welcome?.carId}`);
await B.until(() => (B.roster || []).every((p) => p.online || p.bot), 1500);
ok('回线后在线状态恢复', (B.roster || []).filter((p) => !p.bot).every((p) => p.online), JSON.stringify((B.roster || []).map((p) => `${p.name}:${p.online}${p.bot ? ' bot' : ''}`)));

// ---------- 3. 比赛中掉线 → 自动行驶 → 回线接管 ----------
await Promise.all([A2.ready(true), B.ready(true)]);
await A2.until(() => A2.phase >= PHASE.race, 9000);
await B.until(() => B.snaps > 10, 4000);
ok('全员准备后自动开赛', A2.phase >= PHASE.race && B.snaps > 10, `phase=${A2.phase} 快照=${B.snaps}`);

A2.kill();
await A2.closed;
await Bun.sleep(1300); // 让自动驾驶把车真跑起来，同时仍在 3 秒席位宽限期内
let d = (await debug()).find((r) => r.code === A2.welcome.code);
const autoCar = d && d.cars.find((c) => c.id === carIdA);
ok('掉线车辆被服务端接管', !!autoCar && autoCar.auto === true && autoCar.s > 5, autoCar && `speed=${autoCar.s}`);
const snapsBefore = B.snaps;
await B.until(() => B.snaps > snapsBefore + 20, 4000);
ok('对手掉线后比赛继续推送', B.snaps > snapsBefore + 20, `${snapsBefore} → ${B.snaps}`);

const A3 = new Cli({ name: '甲' });
await A3.hello({ code: A2.welcome.code, token: A2.token });
await A3.until(() => A3.welcome);
ok('比赛中回线仍是同一车位', A3.welcome?.carId === carIdA, `car=${A3.welcome?.carId}`);
ok('比赛中回线直接回到赛况阶段', A3.welcome?.phase >= PHASE.race, `phase=${A3.welcome?.phase} tick=${A3.welcome?.tick}`);
await A3.until(() => A3.snaps > 3, 4000);
ok('回线后继续收到快照', A3.snaps > 3, `${A3.snaps} 帧`);
d = (await debug()).find((r) => r.code === A3.welcome.code);
const backCar = d && d.cars.find((c) => c.id === carIdA);
ok('回线后驾驶权交还真人', !!backCar && backCar.auto === false, backCar && `auto=${backCar.auto}`);
ok('回线客户端 tick 与服务器对齐', Math.abs(A3.welcome.tick - (d ? d.tick : 0)) < 400, `welcome=${A3.welcome.tick} world=${d?.tick}`);

// ---------- 4. 席位过期回收 ----------
A3.kill();
await A3.closed;
await Bun.sleep(3500); // GHOST_RACE_MS=3000
list = await rooms();
d = (await debug()).find((r) => r.code === A3.welcome.code);
ok('超期未回线则释放席位', !!d && d.members === 1, d && `members=${d.members} cars=${d.cars.length}`);
const stillRacing = !!d && d.cars.some((c) => c.human);
ok('超期车辆由服务端继续跑完', stillRacing, d && d.cars.map((c) => `${c.name}${c.auto ? '·auto' : ''}`).join(','));

// ---------- 5. 满员与陌生令牌 ----------
const R = new Cli({ name: '房主' });
await R.hello({ create: 1 });
await R.until(() => R.welcome);
const crowd = [R];
for (let i = 1; i < 6; i++) {
  const c = new Cli({ name: `手${i}`, code: R.welcome.code });
  await c.hello({ code: R.welcome.code });
  await c.until(() => c.welcome);
  crowd.push(c);
}
list = await rooms();
const fullRow = list.find((r) => r.code === R.welcome.code);
ok('满员房间仍在列表但不再可加入', !!fullRow && fullRow.players === 6 && fullRow.listed === false, fullRow && `${fullRow.players}/${fullRow.cap} listed=${fullRow.listed}`);
const late = new Cli({ name: '迟到者' });
await late.hello({ code: R.welcome.code });
await late.until(() => late.err);
ok('满员时拒绝新玩家', /满/.test(late.err), late.err);
const host2 = new Cli({ name: '新房主' });
await host2.hello({ create: 1 });
await host2.until(() => host2.welcome);
const stranger = new Cli({ name: '陌生令牌' });
await stranger.hello({ code: host2.welcome.code, token: 'zzzzzz' });
await stranger.until(() => stranger.welcome || stranger.err);
ok('无效令牌按新玩家加入而非报错', !!stranger.welcome && !stranger.err && !!stranger.token, stranger.err || `car=${stranger.welcome?.carId}`);
stranger.kill();
host2.kill();
for (const c of crowd) c.kill();
for (const c of [B, wrong]) c.kill();
await Bun.sleep(200);

child.kill();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
