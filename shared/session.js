// 联网会话核心：tick 对齐、本车预测与回滚对账、输入打包、他车插值缓冲。
// 不依赖 DOM/THREE，浏览器与 Node 测试用同一份代码。
import { PlayerCar } from './vehicle.js';
import { DT, DT_MS, EDGE_BITS, HOLD_BITS, applyHit } from './race.js';
import {
  C, S, PHASE, Writer, Reader, decodeSnapshot, decodeEvents, decodeRoster, decodeResult, F,
} from './proto.js';
import { damp, dampAngle, clamp, wrapAngle } from './util.js';

const HIST = 512; // 本车输入历史（tick -> [hold, edge]）
export const INTERP_DELAY_MS = 110; // 他车渲染延迟
export const INTERP_DELAY_TICKS = INTERP_DELAY_MS / DT_MS; // 同一延迟，用服务器 tick 表示
const INTERP_BUF = 8; // 他车状态环形缓冲：要能覆盖 延迟/快照间隔 + 抖动余量
const SEND_EVERY_MS = 16; // 输入上行节流
const MAX_RECONNECTS = 6; // 自动回线尝试次数
// 对账修正的偿还方式分两级，这是"高延迟会不会看见瞬移"的分水岭：
//  · 网络慢造成的偏差（实测 400ms 峰值约 2m）：按限额速度滑回去。幅度不设门限，
//    因为领先量随延迟线性增长，任何固定幅度门限都会被顶破，而顶破的那一帧就是瞬移。
//  · 本端整段时间根本没过帧（切后台、页面挂起、弱机 1fps）：物理位姿已经跑出几十米，
//    滑过去等于让镜头以几十米每秒横掠半条赛道——那才是最强烈的晕 3D 诱因。
//    这种情况一次性切镜头（车与相机同时到位），是"你不在场"，不是"网络差"。
const MAX_LAT = 9;      // 滑行时视觉横移最快 9 m/s
const MAX_YAW = 3.0;    // 滑行时视觉朝向最快 3 rad/s
const MAX_PAY_MS = 0.9; // 再大的滑行偏差也要在 0.9s 内偿清，否则车会长时间漂在物理位置之外
const CUT_DIST = 20;    // 超过这个偏差判定为"整段丢失"，直接切镜头（稳定态实测峰值 2m，够不到）

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
    this.lastAck = 0; // 最近一份快照的权威 tick（本端领先量的基准）
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
    this.visual = { x: 0, z: 0, h: 0, t: 0, dur: 0.15 };
    this.tickClock = null; // 本地自由推进的服务器 tick 时钟（不受快照成帧影响）
    this.hardSnap = false; // 仅由 setVisual 在"整段丢失"级别的大偏差上置位，相机同帧重定位
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
        car = { carId: rec.carId, cur: null, buf: [], x: rec.x, y: rec.y, z: rec.z, h: rec.h, s: rec.s, flags: rec.flags, name: '', skin: -1 };
        this.remote.set(rec.carId, car);
      }
      const info = this.rosterFor(rec.carId);
      if (info) { car.name = info.name; car.skin = info.skin; }
      const state = { ...rec, at: nowMs(), tick: snap.tick };
      car.cur = state;
      // 渲染延迟比快照间隔长，只留两条会把渲染点钳在最老的一条上（停一下跳一格），
      // 所以保留一小段环形缓冲，插值取"跨越渲染时刻"的那一对
      car.buf.push(state);
      if (car.buf.length > INTERP_BUF) car.buf.shift();
    }
    for (const id of [...this.remote.keys()]) if (!snap.racers.some((x) => x.carId === id)) this.remote.delete(id);
    if (me) this.reconcile(me);
  }

  rosterFor(carId) { return this.roster.find((x) => x.carId === carId); }

  // ---------- 本车对账 ----------
  // 快照描述的是 ackTick 那一刻的权威状态。本端领先 ackTick 约 2×单程延迟（输入要一个来回
  // 才拿到确认），这是正常量，不是异常：正确做法是"回到 ack 的权威状态，把 ack+1..当前 的
  // 本地输入整段重放"，让本端仍站在当前 tick 上。
  // 早先的实现把领先量截断成固定 24 tick 并把 tick 时钟拽回 ack，等于每来一个快照就丢掉
  // (领先量-24) tick 的位移：240ms 约 3.5m、400ms 约 10m，直接顶破 8m 硬跳门限 → 高延迟瞬移。
  reconcile(rec) {
    if (!this.me) return;
    const ack = rec.ackTick;
    if (ack <= 0) return;
    this.lastAck = ack;
    if (ack > this.tick) {
      // 本端仿真落后于服务器（低帧率/页面挂起）：拿旧环形缓冲比对没有意义。
      // 小段落后用滑行吸收，超过 100ms 就直接重新锚定，别把上百米的路一次性滑过去。
      if (ack - this.tick > 12) this.reanchor(ack, rec);
      else { this.tick = ack; this.restoreAuthoritative(rec); }
      return;
    }
    const gap = this.tick - ack;
    if (gap >= HIST - 8) { this.reanchor(ack, rec); return; } // 超出可重放范围，见 reanchor
    const h = this.hist[this.slot(ack)];
    if (!h || h.t !== ack || !h.k) { this.restoreAuthoritative(rec); return; } // 历史已被覆盖
    const err = Math.hypot(rec.x - h.k[0], rec.z - h.k[1]);
    const serr = Math.abs(rec.s - h.k[5]);
    if (gap > 2) this.maxErr = Math.max(this.maxErr, err);
    if (err < 0.08 && serr < 0.8) return; // 预测与权威一致
    this.rolls++;
    const px = this.me.x, pz = this.me.z, ph = this.me.h;
    this.applyAuthoritative(rec);
    for (let t = ack + 1; t <= this.tick; t++) {
      const hh = this.hist[this.slot(t)];
      if (!hh || hh.t !== t) break;
      this.me.update(DT, frameOf(hh.bits, hh.edge), true, this.itemMode);
    }
    this.setVisual(px - this.me.x, pz - this.me.z, wrapAngle(ph - this.me.h));
  }

  // 本端 tick 与服务器脱出可重放范围（服务器卡顿跑不满 120Hz、或本端长时间挂起）：
  // 未发送的未来输入作废，本车直接站到权威位姿。注意这只复位"本端的 tick 轴"——
  // 服务器的 tick 轴没有变，所以他车缓冲与渲染时钟必须原地保留：清掉缓冲会让所有对手
  // 先定身、再在下一份快照到达时整段跳过来，等于把本车的一次纠偏扩散成全场玩家的瞬移。
  // 本车偏差交给 setVisual 的两级偿还：网络差就滑，整段没跑帧就切。
  reanchor(ack, rec) {
    this.tick = ack;
    this.pending.length = 0;
    const px = this.me.x, pz = this.me.z, ph = this.me.h;
    this.applyAuthoritative(rec);
    this.setVisual(px - this.me.x, pz - this.me.z, wrapAngle(ph - this.me.h));
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
    const px = car.x, pz = car.z, ph = car.h;
    this.applyAuthoritative(rec);
    // 差值交给视觉偏移吸收：模型与相机一起滑回权威轨迹，而不是硬跳
    this.setVisual(px - car.x, pz - car.z, wrapAngle(ph - car.h));
  }

  applyAuthoritative(rec) {
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
    const dtC = Math.min(dtMs, 200) / 1000;
    // 时钟与偏移衰减按真实经过时间推进，即使这一帧物理一个子步都没跑（高帧率时会出现）
    this.advanceClock(dtC * 1000);
    this.decayVisual(dtC);
    // 本端 tick 不能无限领先服务器：服务器的输入队列只有 96 tick 的窗口，超出的输入会被丢弃，
    // 于是权威端在"无人驾驶"地跑，两边真的分叉，最后只能靠硬跳收场。
    // 领先过头就先放慢本地仿真让服务器追上——慢半拍的车，好过凭空瞬移的车。
    this.acc += dtC * this.leadPace();
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
        this.hist[this.slot(this.tick)] = { t: this.tick, bits, edge, k: [this.me.x, this.me.z, this.me.y, this.me.h, this.me.m, this.me.s] };
        this.pending.push([this.tick, bits, edge]);
      }
    }
    if (n === 0) return 0;
    if (nowMs() - this.lastSend >= SEND_EVERY_MS) this.flushInput();
    return n;
  }

  // ---------- 服务器 tick 时钟 ----------
  // 他车插值必须以服务器 tick 为时间轴：快照在网络上是成簇到达的，
  // 用到达时刻做插值会把"两帧一起来"变成瞬间跳位、随后停住 —— 这就是可见的抖动。
  advanceClock(dtMs) {
    if (this.tickClock === null) { this.tickClock = this.worldTick; return; }
    let err = this.worldTick - this.tickClock;
    if (Math.abs(err) > 120) { this.tickClock = this.worldTick; return; } // 重连/长节流：硬对齐
    // 只微调走时速率（±25%），不直接改位置，所以追赶过程本身不可见
    const rate = 1 + clamp(err * 0.02, -0.25, 0.25);
    this.tickClock += (dtMs / DT_MS) * rate;
  }

  // 本端 tick 相对权威 tick 的领先量：正常就是一个往返 + 余量。
  // 超出说明服务器没跟上当日时（卡顿/房间过多），按比例放慢本地仿真让它追上来。
  leadPace() {
    if (!this.aligned || !this.lastAck) return 1;
    const want = 2 * (this.rtt / 1000) / DT + 8;
    const lead = this.tick - this.lastAck;
    if (lead <= want) return 1;
    return clamp(want / lead, 0.4, 1);
  }

  renderTick() {
    return (this.tickClock === null ? this.worldTick : this.tickClock) - INTERP_DELAY_TICKS;
  }

  // ---------- 对账修正的视觉吸收 ----------
  // 修正是叠加的：新修正必须接上上一笔尚未衰减完的偏移，否则这一帧会把旧偏移凭空抹掉，
  // 渲染位姿当场跳掉——快照 20Hz、衰减 0.25s，意味着每笔修正都只走完约 40% 就被下一笔覆盖。
  setVisual(dx, dz, dh) {
    const v = this.visual;
    if (v.t > 0) { dx += v.x; dz += v.z; dh += v.h; }
    const d = Math.hypot(dx, dz);
    const ad = Math.abs(dh);
    if (d < 0.05 && ad < 0.015) return;
    if (d > CUT_DIST) { // 整段丢失：一次切到位，交给相机同步重定位，不做长距离横扫
      this.visual = { x: 0, z: 0, h: 0, t: 0, dur: 0.15 };
      this.hardSnap = true;
      return;
    }
    // 时长由"最大偏差 / 允许的最快偿还速度"给出：偏差越大滑得越久，滑速恒定，
    // 所以无论延迟多高，单帧的视觉横移与转向都不会超过这个上限
    this.visual = {
      x: dx, z: dz, h: dh, t: 1,
      dur: clamp(Math.max(d / MAX_LAT, ad / MAX_YAW), 0.12, MAX_PAY_MS),
    };
  }

  decayVisual(dtS) {
    const v = this.visual;
    if (v.t <= 0) return;
    v.t = Math.max(0, v.t - dtS / (v.dur || 0.15));
    v.x *= v.t; v.z *= v.t; v.h *= v.t;
  }

  // 最终渲染位姿：物理状态 + 尚未衰减完的修正偏移。
  // 模型与相机都只读这一份，避免"模型平滑、相机硬跳"互相拉扯。
  syncPose(dtS) {
    const c = this.me;
    if (!c) return null;
    if (c.syncModel) c.syncModel(dtS);
    const v = this.visual;
    const k = v.t > 0 ? 1 : 0;
    c.rx = c.x + v.x * k;
    c.rz = c.z + v.z * k;
    c.rh = c.h + v.h * k;
    // 相机航向的目标是"行驶朝向" m，它每份快照都会被权威值整份覆盖。
    // 这里给它同一套衰减，相机就不会吃到 m 的阶跃（漂移结束时 m 会一次转掉十几度）。
    c.rm = c.rm === undefined ? c.m : dampAngle(c.rm, c.m, 10, dtS);
    return c;
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

  // 他车插值：以服务器 tick 为时间轴（renderTick = 本地时钟 - 缓冲延迟）
  interpState(car, renderTick) {
    const buf = car.buf && car.buf.length ? car.buf : (car.cur ? [car.cur] : null);
    if (!buf) return null;
    // 取"跨越渲染时刻"的那一对状态；渲染时刻比最新快照老时向后退一对，超出最新快照时直线推算
    let i = buf.length - 1;
    while (i > 0 && buf[i].tick > renderTick) i--;
    const a = buf[i];
    const b = buf[Math.min(i + 1, buf.length - 1)];
    if (b === a) {
      const over = Math.min(0.35, Math.max(0, renderTick - a.tick) * DT);
      return { x: a.x + Math.sin(a.h) * a.s * over, y: a.y, z: a.z + Math.cos(a.h) * a.s * over, h: a.h, s: a.s, flags: a.flags };
    }
    const span = b.tick - a.tick;
    const t = span > 0 ? clamp((renderTick - a.tick) / span, 0, 1) : 1;
    let x = a.x + (b.x - a.x) * t;
    let z = a.z + (b.z - a.z) * t;
    const h = a.h + wrapAngle(b.h - a.h) * t;
    const s = a.s + (b.s - a.s) * t;
    const over = Math.min(0.35, Math.max(0, renderTick - b.tick) * DT);
    if (over > 0) {
      x += Math.sin(h) * s * over;
      z += Math.cos(h) * s * over;
    }
    return { x, y: a.y + (b.y - a.y) * t, z, h, s, flags: b.flags };
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
