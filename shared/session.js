// 联网会话核心：tick 对齐、本车预测与回滚对账、输入打包、他车插值缓冲。
// 不依赖 DOM/THREE，浏览器与 Node 测试用同一份代码。
import { PlayerCar } from './vehicle.js';
import { DT, EDGE_BITS, HOLD_BITS, applyHit } from './race.js';
import {
  C, S, PHASE, Writer, Reader, decodeSnapshot, decodeEvents, decodeRoster, decodeResult, F,
} from './proto.js';
import { damp, clamp, wrapAngle } from './util.js';

const HIST = 512; // 本车输入历史（tick -> [hold, edge]）
export const INTERP_DELAY_MS = 110; // 他车渲染延迟
const SEND_EVERY_MS = 16; // 输入上行节流
const RESYNC_TICKS = 240; // ackTick 偏离过大时硬对齐
const MAX_RECONNECTS = 6; // 自动回线尝试次数

export function frameOf(bits, edge) {
  return {
    up: !!(bits & HOLD_BITS.up), down: !!(bits & HOLD_BITS.down),
    left: !!(bits & HOLD_BITS.left), right: !!(bits & HOLD_BITS.right),
    shift: !!(bits & HOLD_BITS.shift),
    upPressed: !!(edge & EDGE_BITS.up), wPressed: !!(edge & EDGE_BITS.w),
    nitroPressed: !!(edge & EDGE_BITS.nitro), swapPressed: !!(edge & EDGE_BITS.swap),
    resetPressed: !!(edge & EDGE_BITS.reset),
  };
}

export class NetCore {
  constructor(opts) {
    this.opts = opts;
    this.track = opts.track;
    this.me = opts.ownCar || null;
    this.onRoster = opts.onRoster || noop;
    this.onPhase = opts.onPhase || noop;
    this.onResult = opts.onResult || noop;
    this.onEvent = opts.onEvent || noop;
    this.onError = opts.onError || noop;
    this.onWelcome = opts.onWelcome || noop;
    this.onReconnect = opts.onReconnect || noop;
    this.token = opts.token || '';
    this.reconns = 0;
    this.reconT = null;
    this.disposing = false;
    this.resync = false; // 回线后需要先把本车对齐到服务器位置
    this.url = opts.url || defaultWsUrl();

    this.tick = 0; // 本客户端 tick 空间
    this.worldTick = 0; // 服务器比赛 tick（用于计时）
    this.aligned = false;
    this.acc = 0;
    this.seq = 0;
    this.pending = [];
    this.lastSend = 0;
    this.hist = new Array(HIST).fill(null);
    this.remote = new Map(); // carId -> {prev, cur, name, skin, x,y,z,h,s,flags}
    this.myCarId = 0;
    this.roster = [];
    this.phase = PHASE.lobby;
    this.rtt = 40;
    this.pingT = 0;
    this.snapCount = 0;
    this.downBytes = 0;
    this.upBytes = 0;
    this.connected = false;
    this.rolls = 0;
    this.maxErr = 0;
    this.visual = { x: 0, z: 0, h: 0, t: 0 };
    this.snapHz = 0;
    this.grid = 6;
    this.laps = opts.laps || 2;
    this.mode = opts.mode || 0;
    this.itemMode = !!opts.itemMode;
    this.code = '';
    this.lastSnap = null;
    this.open = false;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => { this.connected = true; this.hello(); };
    this.ws.onmessage = (e) => this.onMsg(e.data);
    this.ws.onclose = () => { this.connected = false; this.retry(); };
    this.ws.onerror = () => { this.connected = false; };
  }

  // 断线自动回线：同一令牌找回原席位；超过次数就交给人工
  retry() {
    if (this.disposing) return;
    if (this.reconns >= MAX_RECONNECTS) { this.onError('与服务器断开连接，请重新进入房间'); return; }
    this.reconns++;
    this.onReconnect(this.reconns);
    clearTimeout(this.reconT);
    this.reconT = setTimeout(() => { if (!this.disposing) this.connect(); }, 500 + this.reconns * 500);
  }

  hello() {
    const o = this.opts;
    const w = new Writer(160);
    w.u8(C.HELLO).u8(1).str(o.name).u8(o.skin).str(o.map).u8(o.laps).u8(o.mode).u8(o.diff)
      .str(o.code || '').u8(o.create ? 1 : 0).str(this.token || o.token || '');
    this.raw(w.bytes());
  }

  ready(on) { const w = new Writer(4); w.u8(C.READY).u8(on ? 1 : 0); this.raw(w.bytes()); }

  // 主动退房：放弃席位（区别于掉线，掉线会给车挂上自动驾驶）
  leave() { const w = new Writer(4); w.u8(C.LEAVE); this.raw(w.bytes()); }

  ping() { const w = new Writer(8); w.u8(C.PING).u32(Date.now() & 0xffffffff); this.raw(w.bytes()); }

  raw(bytes) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(bytes); return; }
    if (this.ws && this.ws.readyState === 0) this.ws.addEventListener('open', () => this.ws.send(bytes), { once: true });
  }

  onMsg(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.downBytes += bytes.byteLength;
    const r = new Reader(bytes);
    const type = r.u8();
    switch (type) {
      case S.WELCOME: {
        this.myCarId = r.u16();
        this.code = r.str();
        this.mapId = r.str();
        this.laps = r.u8();
        this.mode = r.u8();
        this.phase = r.u8();
        this.tick = r.u32();
        this.aligned = true;
        this.seed = r.u32();
        this.grid = r.u8();
        this.snapHz = r.u8();
        if (!r.eof) r.u32(); // 房间已运行时长，仅占位
        if (!r.eof) this.token = r.str();
        // 回线/新开：本地预测历史作废，第一帧快照先把本车摆回权威位置
        this.hist.fill(null);
        this.pending.length = 0;
        this.resync = this.phase >= PHASE.countdown;
        const rejoined = this.reconns > 0 || !!this.everWelcome;
        this.reconns = 0;
        this.everWelcome = true;
        this.onWelcome({
          code: this.code, laps: this.laps, mode: this.mode, mapId: this.mapId,
          grid: this.grid, carId: this.myCarId, token: this.token, phase: this.phase, rejoined,
        });
        break;
      }
      case S.ROSTER: {
        const { extra, list } = decodeRoster(r);
        this.roster = list;
        if (extra !== this.phase) { this.phase = extra; this.onPhase(extra); }
        this.onRoster(list);
        break;
      }
      case S.SNAP: {
        this.snapCount++;
        this.applySnap(decodeSnapshot(r));
        break;
      }
      case S.EV: {
        for (const ev of decodeEvents(r)) this.onEvent(ev);
        break;
      }
      case S.RESULT: {
        this.phase = PHASE.result;
        this.onResult(decodeResult(r));
        break;
      }
      case S.PONG: {
        const t0 = r.u32();
        r.u32();
        const rtt = (Date.now() & 0xffffffff) - t0;
        if (rtt > 0 && rtt < 4000) this.rtt = damp(this.rtt, rtt, 4, 0.12);
        break;
      }
      case S.ERR:
        this.onError(r.str());
        break;
    }
  }

  applySnap(snap) {
    this.lastSnap = snap;
    this.worldTick = snap.tick;
    if (this.phase !== snap.phase) { this.phase = snap.phase; this.onPhase(snap.phase); }
    let me = null;
    for (const rec of snap.racers) {
      if (rec.carId === this.myCarId) { me = rec; continue; }
      let car = this.remote.get(rec.carId);
      if (!car) {
        car = { carId: rec.carId, prev: null, cur: null, x: rec.x, y: rec.y, z: rec.z, h: rec.h, s: rec.s, flags: rec.flags, name: '', skin: -1 };
        this.remote.set(rec.carId, car);
      }
      const info = this.rosterFor(rec.carId);
      if (info) { car.name = info.name; car.skin = info.skin; }
      car.prev = car.cur;
      car.cur = { ...rec, at: nowMs() };
    }
    for (const id of [...this.remote.keys()]) if (!snap.racers.some((x) => x.carId === id)) this.remote.delete(id);
    if (me) this.reconcile(me);
  }

  rosterFor(carId) { return this.roster.find((x) => x.carId === carId); }

  // ---------- 本车对账 ----------
  // 快照描述的是 ackTick 那一刻的权威状态；把它与本地当时记录的历史比对，
  // 预测正确就不回滚（否则每个快照都要重放几十 tick）。
  reconcile(rec) {
    if (!this.me) return;
    const ack = rec.ackTick;
    if (ack <= 0) return;
    if (Math.abs(ack - this.tick) > RESYNC_TICKS) this.tick = ack;
    if (ack > this.tick) {
      // 本端仿真落后于服务器（低帧率/后台节流）：直接快进到权威状态，不能拿旧环形缓冲比对
      this.tick = ack;
      this.restoreAuthoritative(rec);
      return;
    }
    if (this.tick - ack > 24) {
      // 本端跑到了服务器前面（长卡顿后 dt 一次性补太多）：退回到权威 tick，
      // 否则这些"未来 tick"的输入会溢出服务器输入队列（上限 96），造成真实分歧
      const px = this.me.x, pz = this.me.z, ph = this.me.h;
      this.tick = ack;
      this.restoreAuthoritative(rec);
      const dx = px - this.me.x, dz = pz - this.me.z, dh = wrapAngle(ph - this.me.h);
      if (Math.hypot(dx, dz) > 0.3 || Math.abs(dh) > 0.05) this.visual = { x: dx, z: dz, h: dh, t: 1 };
      this.rolls++;
      return;
    }
    const h = this.hist[this.slot(ack)];
    if (!h) { this.restoreAuthoritative(rec); return; } // 历史已被覆盖
    if (h.k) {
      const err = Math.hypot(rec.x - h.k[0], rec.z - h.k[1]);
      const serr = Math.abs(rec.s - h.k[5]);
      if (ack < this.tick - 2) this.maxErr = Math.max(this.maxErr, err);
      if (err < 0.08 && serr < 0.8) return; // 预测与权威一致
      this.rolls++;
      const px = this.me.x, pz = this.me.z, ph = this.me.h;
      this.restoreAuthoritative(rec);
      for (let t = ack + 1; t <= this.tick; t++) {
        const hh = this.hist[this.slot(t)];
        if (!hh) break;
        this.me.update(DT, frameOf(hh.bits, hh.edge), true, this.itemMode);
      }
      const dx = px - this.me.x, dz = pz - this.me.z, dh = wrapAngle(ph - this.me.h);
      if (Math.hypot(dx, dz) > 0.08 || Math.abs(dh) > 0.03) this.visual = { x: dx, z: dz, h: dh, t: 1 };
    } else {
      this.restoreAuthoritative(rec);
    }
  }

  // 本车被权威结算命中：冲击先在本端同样生效（否则本地预测会一直跑在服务器前面），
  // 再以下一帧快照兜底对齐，两边用的是同一份 applyHit
  selfHit(kind) {
    if (!this.me) return;
    applyHit(this.me, kind);
    this.resync = true;
  }

  restoreAuthoritative(rec) {
    const car = this.me;
    car.x = rec.x; car.z = rec.z; car.y = rec.y;
    car.h = rec.h; car.m = rec.m; car.s = rec.s;
    car.drifting = !!(rec.flags & F.drifting);
    car.airborne = !!(rec.flags & F.airborne);
    car.nitroCount = rec.nitroCount;
    car.gauge = rec.gauge;
    car.lapsDone = rec.lap - 1;
    car.progress = rec.progress;
    car.finished = !!(rec.flags & F.finished);
    car.auto = !!(rec.flags & F.auto);
    const p = this.track.project(car.x, car.y, car.z, car.hint, car.proj || (car.proj = {}));
    car.hint = p.i; car.d = p.d; car.lat = p.lat;
  }

  slot(t) { return ((t % HIST) + HIST) % HIST; }

  // ---------- 推进 ----------
  // 弱机/低帧率时允许一帧补跑更多 tick：联机必须以服务器的真实时间为基准，不能慢放
  step(dtMs, inp, active) {
    this.pingT += dtMs;
    if (this.pingT > 1000) { this.pingT = 0; this.ping(); }
    this.acc += Math.min(dtMs, 200) / 1000;
    let n = 0;
    while (this.acc >= DT && n < 60) {
      this.acc -= DT;
      n++;
      const bits = (inp.up ? HOLD_BITS.up : 0) | (inp.down ? HOLD_BITS.down : 0) |
        (inp.left ? HOLD_BITS.left : 0) | (inp.right ? HOLD_BITS.right : 0) | (inp.shift ? HOLD_BITS.shift : 0);
      const edge = n === 1
        ? ((inp.upPressed ? EDGE_BITS.up : 0) | (inp.wPressed ? EDGE_BITS.w : 0) |
           (inp.nitroPressed ? EDGE_BITS.nitro : 0) | (inp.swapPressed ? EDGE_BITS.swap : 0) |
           (inp.resetPressed ? EDGE_BITS.reset : 0))
        : 0;
      this.tick++;
      if (active && this.me) {
        this.me.update(DT, frameOf(bits, edge), true, this.itemMode);
        this.hist[this.slot(this.tick)] = { bits, edge, k: [this.me.x, this.me.z, this.me.y, this.me.h, this.me.m, this.me.s] };
        this.pending.push([this.tick, bits, edge]);
      }
    }
    if (n === 0) return 0;
    if (nowMs() - this.lastSend >= SEND_EVERY_MS) this.flushInput();
    if (this.visual.t > 0) {
      this.visual.t = Math.max(0, this.visual.t - dtMs / 150);
      this.visual.x *= this.visual.t;
      this.visual.z *= this.visual.t;
      this.visual.h *= this.visual.t;
    }
    return n;
  }

  // 低帧率时一帧可能攒了几十个 tick 的输入，用多个小包发完（每包 8 tick，与服务器上限一致）
  flushInput() {
    this.lastSend = nowMs();
    let packets = 0;
    while (this.pending.length && packets++ < 8) {
      const take = Math.min(this.pending.length, 8);
      const w = new Writer(8 + take * 2);
      w.u8(C.INPUT).u16(this.seq++).u32(this.pending[0][0]).u8(take);
      for (let i = 0; i < take; i++) w.u8(this.pending[i][1]).u8(this.pending[i][2]);
      this.upBytes += w.len;
      this.raw(w.bytes());
      this.pending.splice(0, take);
    }
  }

  get raceTime() { return Math.max(0, (this.worldTick - 360) / 120); }

  // 他车插值：renderAt = now - INTERP_DELAY_MS
  interpState(car, renderAt) {
    const a = car.prev || car.cur, b = car.cur;
    if (!b) return null;
    let t = 1;
    if (car.prev) {
      const span = b.at - a.at;
      t = span > 0 ? clamp((renderAt - a.at) / span, 0, 1.4) : 1;
    }
    const k = Math.min(1, t);
    let x = a.x + (b.x - a.x) * k;
    let z = a.z + (b.z - a.z) * k;
    const h = a.h + wrapAngle(b.h - a.h) * k;
    const s = a.s + (b.s - a.s) * k;
    if (t > 1) {
      const step = s * (t - 1) * 0.06;
      x += Math.sin(h) * step;
      z += Math.cos(h) * step;
    }
    return { x, y: a.y + (b.y - a.y) * k, z, h, s, flags: b.flags };
  }

  stats() {
    return {
      rtt: Math.round(this.rtt), hz: this.snapHz, rolls: this.rolls, maxErr: +this.maxErr.toFixed(3),
      kbDown: +(this.downBytes / 1024).toFixed(1), kbUp: +(this.upBytes / 1024).toFixed(1),
      phase: this.phase, code: this.code, connected: this.connected, snaps: this.snapCount,
    };
  }

  dispose() {
    this.disposing = true;
    clearTimeout(this.reconT);
    try { this.ws?.close(); } catch { /* 已关闭 */ }
  }
}

function noop() {}
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function defaultWsUrl() {
  if (typeof location === 'undefined') return 'ws://localhost:8790/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export { PHASE, PlayerCar };
