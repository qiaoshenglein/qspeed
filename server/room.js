// 房间：一个 Room = 一份权威 RaceWorld + 一组席位 + 一个 120Hz 仿真循环
// 大厅阶段只有真人车；开赛时按空位补 bot，回大厅时撤掉 bot。
// 席位用令牌绑定"玩家身份"，与连接无关：断线后车留在场上，凭令牌回线继续开同一台车。
import { RaceWorld, DT_MS, GRID } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { AI_NAMES } from '../shared/ai.js';
import { C, S, PHASE, Writer, Reader, encodeSnapshot, encodeEvents, encodeRoster, encodeResult } from '../shared/proto.js';

const SNAP_EVERY = 6; // 20Hz 快照
const MAX_INPUTS_PER_SEC = 100;
const RESTART_AFTER_MS = 8000;
const START_GRACE_MS = 5000; // 全员准备后的邀请窗口，期间有人加入则重新等待
const LOBBY_GHOST_MS = Number(process.env.GHOST_LOBBY_MS || 180000); // 大厅掉线：席位保留 3 分钟（刷新页面不算离开）
const RACE_GHOST_MS = Number(process.env.GHOST_RACE_MS || 45000); // 比赛掉线：席位保留 45 秒，超时后车由电脑开完本场
const BOT_SKILLS = [0.9, 1.0, 1.05, 1.15, 1.25];

export class Room {
  constructor(app, code, opts) {
    this.app = app;
    this.code = code;
    this.mapId = MAPS.some((m) => m.id === opts.map) ? opts.map : 'city';
    this.laps = opts.laps || 2;
    this.mode = opts.mode || 0; // 0 竞速 · 1 道具
    this.diff = opts.diff ?? 1;
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.createdAt = Date.now();
    this.startedAt = Date.now();
    this.seats = new Map(); // token -> member
    this.members = new Map(); // ws -> member（只存在于线连接）
    this.phase = PHASE.lobby;
    this.timer = null;
    this.acc = 0;
    this.tickAcc = 0;
    this.lastMs = 0;
    this.evBuf = [];
    this.track = new TrackSim(LAYOUTS[MAPS.find((m) => m.id === this.mapId).layout], {
      isBridge: MAPS.find((m) => m.id === this.mapId).isBridge,
    });
    this.world = new RaceWorld({ track: this.track, seed: this.seed, laps: this.laps, itemMode: this.mode === 1, diff: this.diff });
    this.botSeed = 0;
  }

  get map() { return MAPS.find((m) => m.id === this.mapId); }
  get humans() { return [...this.seats.values()]; }
  get onlineHumans() { return this.humans.filter((m) => m.online); }
  get inLobby() { return this.phase === PHASE.lobby; }
  get full() { return this.seats.size >= GRID; }

  // 房间列表用：只暴露公开信息
  summary() {
    return {
      code: this.code,
      map: this.mapId,
      mapName: this.map ? this.map.name : this.mapId,
      laps: this.laps,
      mode: this.mode,
      players: this.seats.size,
      online: this.onlineHumans.length,
      cap: GRID,
      phase: this.phase,
      listed: this.inLobby && !this.full,
    };
  }

  // ---------- 席位 ----------
  newToken() {
    let t;
    do {
      t = Math.random().toString(36).slice(2, 8) + ((this.world.tick + this.seats.size) >>> 0).toString(36).slice(-4);
    } while (this.seats.has(t));
    return t;
  }

  canJoin(info) {
    if (this.phase !== PHASE.lobby) return '比赛进行中，请稍候';
    if (this.full) return '房间已满';
    if (info.map && info.map !== this.mapId) return `房间地图是 ${this.map.name}`;
    if (info.laps && info.laps !== this.laps) return `房间圈数是 ${this.laps} 圈`;
    if (info.mode !== undefined && info.mode !== this.mode) return '房间模式不同';
    return null;
  }

  join(ws, info) {
    // 凭令牌回线：沿用原席位与原车，不新建
    const seat = info.token ? this.seats.get(info.token) : null;
    if (seat && !seat.online) return this.reattach(seat, ws, info);
    if (seat && seat.online) {
      // 同一令牌的两个连接：后者接管（前一个网络没断但用户开了两个标签）
      this.detach(seat);
      return this.reattach(seat, ws, info);
    }
    const err = this.canJoin(info);
    if (err) { this.send(ws, errBytes(err)); return null; }
    const used = new Set(this.world.cars.map((c) => c.slot));
    let slot = 0;
    while (used.has(slot) && slot < GRID) slot++;
    const car = this.world.addHuman(ws.data.connId, info.name, info.skin);
    car.slot = Math.min(slot, GRID - 1);
    const member = {
      ws, car, token: this.newToken(), name: car.name, skin: info.skin, slot: car.slot,
      ready: false, online: true, inputs: 0, inputWindowMs: 0, rtt: 0, ghostT: null,
    };
    this.seats.set(member.token, member);
    this.members.set(ws, member);
    // 新来者让邀请窗口重新计时，朋友凭房间码还能挤进来
    clearTimeout(this.startT);
    this.startT = null;
    this.startAt = 0;
    this.broadcastRoster();
    return member;
  }

  reattach(seat, ws, info) {
    clearTimeout(seat.ghostT);
    seat.ghostT = null;
    seat.ws = ws;
    seat.online = true;
    seat.inputs = 0;
    seat.inputWindowMs = 0;
    if (info && info.name) { seat.name = info.name; seat.car.name = info.name; }
    if (info && info.skin !== undefined) { seat.skin = info.skin; seat.car.skin = info.skin | 0; }
    this.members.set(ws, seat);
    // 比赛中的车正被服务端自动驾驶，交还驾驶权
    if (seat.car.auto) { seat.car.auto = false; seat.car.autoD = 0; }
    if (this.inLobby) seat.ready = false;
    this.broadcastRoster();
    return seat;
  }

  welcome(ws, m) {
    const w = new Writer(128);
    w.u8(S.WELCOME).u16(m.car.carId).str(this.code).str(this.mapId)
      .u8(this.laps).u8(this.mode).u8(this.phase).u32(this.world.tick).u32(this.seed)
      .u8(GRID).u8(SNAP_HZ).u32(Date.now() - this.startedAt).str(m.token);
    this.send(ws, w.bytes());
  }

  // 断开一条连接：比赛中车留在场上由服务端接管，真人可在宽限期内回线
  drop(ws) {
    const m = this.members.get(ws);
    if (!m || m.ws !== ws) return; // 已被新连接接管，旧 socket 的关闭不影响席位
    this.detach(m);
    this.broadcastRoster();
    if (!this.seats.size) this.app.closeRoom(this);
  }

  detach(m) {
    if (m.ws) this.members.delete(m.ws);
    m.ws = null;
    m.online = false;
    m.ready = false;
    if (this.phase !== PHASE.lobby) this.world.makeAutopilot(m.car);
    m.ghostT = setTimeout(() => this.expire(m), this.inLobby ? LOBBY_GHOST_MS : RACE_GHOST_MS);
  }

  expire(m) {
    if (m.online) return;
    m.ghostT = null;
    if (this.seats.get(m.token) === m) this.seats.delete(m.token);
    if (this.inLobby) {
      this.world.removeCar(m.car);
      this.reslot();
      this.broadcastRoster();
      if (!this.seats.size) this.app.closeRoom(this);
      return;
    }
    // 比赛/结算中：车继续由服务端自动驾驶跑完，席位不再保留
    if (!this.seats.size && this.phase === PHASE.result) this.app.closeRoom(this);
  }

  reslot() {
    this.world.cars.sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < this.world.cars.length; i++) {
      this.world.cars[i].slot = i;
      const m = this.humans.find((x) => x.car === this.world.cars[i]);
      if (m) m.slot = i;
    }
  }

  // ---------- 消息 ----------
  onMessage(ws, data) {
    let r;
    try { r = new Reader(data); } catch { return; }
    let type;
    try { type = r.u8(); } catch { return; }

    if (type === C.HELLO) {
      const proto = r.u8();
      const info = readHello(r);
      if (proto !== PROTO_VER) { this.send(ws, errBytes('客户端版本不匹配')); return; }
      const m = this.join(ws, info);
      if (!m) return;
      this.welcome(ws, m);
      return;
    }

    const m = this.members.get(ws);
    if (!m || !m.online) return;
    switch (type) {
      case C.READY: {
        m.ready = r.u8() !== 0;
        this.broadcastRoster();
        this.maybeStart();
        break;
      }
      case C.INPUT: {
        const inp = readInput(r);
        if (!inp) return;
        const now = performance.now();
        if (now - m.inputWindowMs > 1000) { m.inputs = 0; m.inputWindowMs = now; }
        if (++m.inputs > MAX_INPUTS_PER_SEC) return; // 超频输入丢弃
        // tick 对齐按包校准一次（按子步校准会成倍过冲）
        this.world.updateBias(m.car, inp.baseTick + inp.subs.length - 1, this.world.tick);
        for (let i = 0; i < inp.subs.length; i++) {
          const t = inp.baseTick + i;
          if (!this.world.queueInput(m.car, t, inp.subs[i][0], inp.subs[i][1])) m.dropped = (m.dropped || 0) + 1;
        }
        break;
      }
      case C.PING: {
        const t0 = r.u32();
        const w = new Writer(16);
        w.u8(S.PONG).u32(t0).u32(Date.now() - this.startedAt).u16(Math.round(m.rtt || 0));
        this.send(m.ws, w.bytes());
        break;
      }
      case C.LEAVE:
        this.expireSeat(m);
        break;
    }
  }

  // 主动离开：立刻放弃席位（区别于网络掉线）
  expireSeat(m) {
    clearTimeout(m.ghostT);
    if (m.ws) this.members.delete(m.ws);
    if (this.seats.get(m.token) === m) this.seats.delete(m.token);
    m.online = false;
    m.ws = null;
    if (this.inLobby) {
      this.world.removeCar(m.car);
      this.reslot();
    } else {
      this.world.makeAutopilot(m.car);
    }
    this.broadcastRoster();
    if (!this.seats.size) this.app.closeRoom(this);
  }

  maybeStart() {
    if (this.phase !== PHASE.lobby) return;
    const humans = this.onlineHumans;
    if (!humans.length || !humans.every((x) => x.ready)) {
      clearTimeout(this.startT);
      this.startT = null;
      this.startAt = 0;
      return;
    }
    if (!this.startAt) this.startAt = Date.now() + START_GRACE_MS;
    if (Date.now() >= this.startAt) {
      clearTimeout(this.startT);
      this.startT = null;
      this.startAt = 0;
      this.startRace();
      return;
    }
    if (!this.startT) {
      this.startT = setTimeout(() => { this.startT = null; this.maybeStart(); }, this.startAt - Date.now());
    }
  }

  startRace() {
    this.reslot();
    // 空位补 bot
    const used = new Set(this.world.cars.map((c) => c.slot));
    for (let i = 0; i < GRID; i++) {
      if (used.has(i)) continue;
      const car = this.world.addBot(AI_NAMES[i % AI_NAMES.length], BOT_SKILLS[this.botSeed++ % BOT_SKILLS.length]);
      car.slot = i;
    }
    this.world.startCountdown();
    this.phase = PHASE.countdown;
    this.tickAcc = 0;
    this.evBuf.length = 0;
    this.acc = 0;
    this.lastMs = performance.now();
    this.broadcastRoster();
    if (!this.timer) this.timer = setInterval(() => this.loop(), 1000 / 120);
  }

  // ---------- 仿真循环 ----------
  loop() {
    const now = performance.now();
    let elapsed = now - this.lastMs;
    this.lastMs = now;
    if (elapsed > 200) elapsed = 200; // 事件循环被卡住时不要猛追
    this.acc += elapsed;
    let guard = 0;
    while (this.acc >= DT_MS && guard++ < 24) {
      this.acc -= DT_MS;
      this.world.step();
      for (const e of this.world.eventsOut) this.evBuf.push(e);
      if (this.phase === PHASE.countdown && this.world.state === 'race') this.phase = PHASE.race;
      if (this.world.state === 'result') { this.endRace(); return; }
      if (++this.tickAcc >= SNAP_EVERY) { this.tickAcc = 0; this.flush(); }
    }
  }

  flush() {
    if (this.phase >= PHASE.countdown) {
      const snap = encodeSnapshot(this.world, this.world.tick, this.phase);
      for (const m of this.seats.values()) if (m.online) this.send(m.ws, snap);
    }
    if (this.evBuf.length) {
      const ev = encodeEvents(this.evBuf);
      for (const m of this.seats.values()) if (m.online) this.send(m.ws, ev);
      this.evBuf.length = 0;
    }
  }

  endRace() {
    this.phase = PHASE.result;
    this.flush();
    const res = encodeResult(this.world);
    for (const m of this.seats.values()) if (m.online) this.send(m.ws, res);
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.resetT);
    this.resetT = setTimeout(() => this.toLobby(), RESTART_AFTER_MS);
  }

  toLobby() {
    clearTimeout(this.resetT);
    for (const c of [...this.world.cars]) if (!c.isPlayer) this.world.removeCar(c);
    this.world.state = 'lobby';
    this.phase = PHASE.lobby;
    this.startAt = 0;
    for (const m of this.seats.values()) {
      m.ready = false;
      if (m.online && m.ws) {
        if (!this.world.cars.includes(m.car)) m.car = this.world.addHuman(m.ws.data.connId, m.name, m.skin);
        m.car.slot = m.slot;
      } else {
        // 掉线席位：车停在原地没有意义，重新摆回发车格等他回来
        placeGridReset(this.world, m);
      }
    }
    this.reslot();
    this.broadcastRoster();
    if (!this.seats.size) this.app.closeRoom(this);
  }

  broadcastRoster() {
    const list = this.world.cars.map((c) => {
      const m = this.humans.find((x) => x.car === c);
      return {
        carId: c.carId, slot: m ? m.slot : c.slot, skin: m ? m.skin : -1,
        bot: !c.isPlayer, online: m ? m.online : true, ready: m ? m.ready : false,
        name: c.name,
      };
    });
    const bytes = encodeRoster(list, this.phase);
    for (const m of this.seats.values()) if (m.online) this.send(m.ws, bytes);
  }

  send(ws, bytes) {
    if (!ws) return;
    try { ws.send(bytes); } catch { /* 连接可能刚断 */ }
  }

  dispose() {
    clearInterval(this.timer);
    clearTimeout(this.resetT);
    clearTimeout(this.startT);
    for (const m of this.seats.values()) clearTimeout(m.ghostT);
    for (const m of this.seats.values()) if (m.ws) { try { m.ws.close(); } catch { /* 已断 */ } }
  }
}

// 掉线席位回大厅后重置车辆比赛状态
function placeGridReset(world, m) {
  const car = m.car;
  if (!world.cars.includes(car)) {
    const nc = world.addHuman(-1, m.name, m.skin);
    m.car = nc;
    return;
  }
  car.finished = false;
  car.finishTime = 0;
  car.lapTimes = [];
  car.items = [];
  car.auto = false;
  car.lapsDone = -1;
}

const PROTO_VER = 1;
const SNAP_HZ = Math.round(120 / SNAP_EVERY);

// HELLO 尾部字段（create / token / lock）是可选的，旧包缺字段时按默认值处理
function readHello(r) {
  const info = { name: r.str(), skin: r.u8(), map: r.str(), laps: r.u8(), mode: r.u8(), diff: r.u8(), code: r.str() };
  if (!r.eof) info.create = r.u8();
  if (!r.eof) info.token = r.str();
  return info;
}

function readInput(r) {
  try {
    const seq = r.u16();
    const baseTick = r.u32();
    const n = r.u8();
    if (n === 0 || n > 8 || r.pos + n * 2 > r.len) return null;
    const subs = [];
    for (let i = 0; i < n; i++) subs.push([r.u8(), r.u8()]);
    return { seq, baseTick, subs };
  } catch { return null; }
}

export function errBytes(msg) {
  const w = new Writer(64);
  w.u8(S.ERR).str(msg);
  return w.bytes();
}

export { GRID, readHello };
