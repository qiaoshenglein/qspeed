// 权威比赛世界：发车格、固定步长仿真、车-车碰撞、圈数/名次、倒计时与起步喷。
// 服务端直接跑它；客户端只跑自己那台车（预测），其余状态来自快照。
import { PlayerCar } from './vehicle.js';
import { AICar } from './ai.js';
import { ItemsLogic, ITEM_CODE } from './items.js';
import { mulberry32, clamp, wrapAngle } from './util.js';

export const DT = 1 / 120;
export const DT_MS = 1000 / 120;
export const CD_TICKS = 360; // 3 秒倒计时
export const GRID = 6;

// 无渲染依赖的模型替身：服务端不需要真的车模
export function stubModel() {
  const v3 = { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } };
  const rot = { x: 0, y: 0, z: 0 };
  return {
    position: v3,
    rotation: Object.assign({ set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } }, rot),
    userData: { root: { rotation: { x: 0, y: 0, z: 0 } }, wheels: [], flames: [], shield: { visible: false }, flameMatOuter: { color: { setHex() { return this; }, multiplyScalar() { return this; } } } },
  };
}

export const DIFFS = [
  { id: 0, name: '新手', skill: [0.55, 0.75], rubber: [0.88, 1.03] },
  { id: 1, name: '熟练', skill: [0.85, 1.05], rubber: [0.93, 1.06] },
  { id: 2, name: '车神', skill: [1.2, 1.38], rubber: [0.97, 1.1] },
];

// 把键盘位图转成车辆输入帧（与 input.js frame() 输出同构）
export function frameFromBits(bits, edges = 0) {
  return {
    up: !!(bits & 1),
    down: !!(bits & 2),
    left: !!(bits & 4),
    right: !!(bits & 8),
    shift: !!(bits & 16),
    upPressed: !!(edges & 1),
    wPressed: !!(edges & 2),
    nitroPressed: !!(edges & 4),
    swapPressed: !!(edges & 8),
    resetPressed: !!(edges & 16),
  };
}

export const HOLD_BITS = { up: 1, down: 2, left: 4, right: 8, shift: 16 };
export const EDGE_BITS = { up: 1, w: 2, nitro: 4, swap: 8, reset: 16 };

// 发车格：两列交错，每排后退 11 米
export function gridPose(slot) {
  return { d: -14 - Math.floor(slot / 2) * 11, lat: (slot % 2 ? 1 : -1) * 5.5 };
}

// 把车放到发车格并清零比赛相关状态（客户端预测本车时也调用它，保证两端一致）
export function placeOnGrid(car, slot) {
  const { d, lat } = gridPose(slot);
  car.reset(d, lat);
  car.slot = slot;
  car.lapTimes = [];
  car.items = [];
  car.finished = false;
  car.finishTime = 0;
  car.lapStart = 0;
  car.startTried = false;
  car.startBoostReady = false;
  car.holdBits = 0;
  car.lapsDone = car instanceof PlayerCar ? -1 : 0;
  car.owed = true;
  car.half = false;
  car.lastD = car.d;
  car.progress = d;
  car.place = slot + 1;
  car.auto = false;
  if (!car.stats) car.stats = { drift: 0, small: 0, perfect: 0, double: 0, nitro: 0, crash: 0, top: 0, land: 0 };
  if (car.isPlayer) car.bias = car.bias || 0;
}

let nextCarId = 1;

// 命中冲击的唯一实现：服务器结算、单机表现、联机客户端预测补偿都走这里，
// 否则同一件事在三处有不同的物理，预测误差会变成永远对不上的分歧。
export function applyHit(car, kind) {
  if (car.shield > 0) { car.shield = 0; return 'shield'; }
  car.spin = kind === 'missile' ? 1.3 : 1.0;
  car.s *= 0.35;
  if (kind === 'missile') { car.airborne = true; car.vy = 8; }
  if (car.endDrift) car.endDrift(false);
  return 'hit';
}

export class RaceWorld {
  constructor(opts) {
    this.track = opts.track;
    this.laps = opts.laps || 2;
    this.itemMode = !!opts.itemMode;
    this.diff = DIFFS[opts.diff ?? 1];
    this.rnd = mulberry32((opts.seed >>> 0) || 12345);
    this.tick = 0;
    this.state = 'lobby'; // lobby | countdown | race | finish | result
    this.cars = [];
    this.standings = [];
    this.firstFinish = -1;
    this.pendingInputs = new Map(); // carId -> Map(tick -> frame)
    this.eventsOut = []; // 本 tick 产生的网络事件（音效/特效/统计）
    this.items = null;
    if (this.itemMode) {
      const items = new ItemsLogic(this.track, opts.seed || 1, {
        hitRacer: (car, kind) => this.hitRacer(car, kind),
        racerAhead: (car, standings) => {
          const st = standings || this.standings;
          const i = st.indexOf(car);
          return i > 0 ? st[i - 1] : null;
        },
        onGrant: (car, item, box) => this.eventsOut.push({ carId: car.carId, type: 'itemGet', box: items.boxes.indexOf(box), kind: item }),
        onUse: (car, item) => this.eventsOut.push({ carId: car.carId, type: 'itemUse', kind: ITEM_CODE[item] || 0 }),
        onMissileLock: (target, owner) => this.eventsOut.push({ carId: owner.carId, type: 'missileLock', who: target ? target.carId : 0 }),
      });
      this.items = items;
    }
  }

  // ---------- 成员 ----------
  addHuman(connId, name, skin) {
    const car = new PlayerCar(this.track, stubModel(), name || '车手');
    car.isPlayer = true;
    car.netId = connId;
    car.carId = nextCarId++;
    car.skin = skin | 0;
    car.slot = -1;
    car.lapTimes = [];
    car.items = [];
    car.finished = false;
    car.finishTime = 0;
    car.stats = { drift: 0, small: 0, perfect: 0, double: 0, nitro: 0, crash: 0, top: 0, land: 0 };
    car.lapsDone = -1;
    car.owed = true;
    car.half = false;
    car.lastD = 0;
    car.bias = 0; // 服务器 tick 与该客户端 tick 的偏移估计
    car.delay = 3; // 输入目标 tick 相对到达时刻的提前量
    this.cars.push(car);
    return car;
  }

  addBot(name, skill) {
    const car = new AICar(this.track, stubModel(), name, skill, this.rnd);
    car.netId = null;
    car.carId = nextCarId++;
    car.skin = -1;
    car.slot = -1;
    car.lapTimes = [];
    car.items = [];
    car.finished = false;
    car.finishTime = 0;
    car.stats = { drift: 0, small: 0, perfect: 0, double: 0, nitro: 0, crash: 0, top: 0, land: 0 };
    this.cars.push(car);
    return car;
  }

  removeCar(car) {
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  // 掉线接管：保持同一台 PlayerCar，用服务端自动驾驶喂输入
  makeAutopilot(car) {
    car.auto = true;
    car.autoD = 0;
  }

  // ---------- 比赛流程 ----------
  startCountdown() {
    for (const c of this.cars) {
      placeOnGrid(c, c.slot);
      if (c.isPlayer) { c.bias = 0; }
    }
    this.tick = 0;
    if (this.items) this.items.reset();
    this.state = 'countdown';
    this.firstFinish = -1;
    this.pendingInputs.clear();
    this.updateStandings();
  }

  get raceTicks() { return this.tick - CD_TICKS; }
  get raceTime() { return Math.max(0, this.raceTicks) * DT; }

  // 排队输入：客户端 tick 换算到服务器 tick
  queueInput(car, clientTick, bits, edges) {
    if (this.state !== 'race' && this.state !== 'countdown') return false;
    if (car.finished) return false;
    let at = clientTick + car.bias;
    if (at < this.tick) {
      // 迟到的包：按住状态无所谓（已用上一帧延续），但边沿（氮气/小喷/复位）必须补上，
      // 否则弱网玩家的关键操作会凭空消失
      if (!edges || this.tick - at > 30) return false;
      at = this.tick;
    }
    if (at > this.tick + 96) return false; // 异常超前
    let m = this.pendingInputs.get(car.carId);
    if (!m) this.pendingInputs.set(car.carId, (m = new Map()));
    const prev = m.get(at);
    m.set(at, prev ? [bits | prev[0], edges | prev[1]] : [bits, edges]);
    if (m.size > 96) for (const k of m.keys()) if (k < at - 96) m.delete(k);
    return true;
  }

  // 取本 tick 的输入帧（含按住状态延续）
  consumeInput(car) {
    if (car.auto || car.finished) return { frame: autopilotFrame(this.track, car), edges: 0 };
    const m = this.pendingInputs.get(car.carId);
    const got = m && m.get(this.tick);
    if (m) {
      m.delete(this.tick);
      if (m.size > 24) for (const k of m.keys()) if (k <= this.tick) m.delete(k); // 清掉 bias 调整时漏掉的旧帧
    }
    if (got) {
      car.holdBits = got[0];
      return { frame: frameFromBits(got[0], got[1]), edges: got[1] };
    }
    return { frame: frameFromBits(car.holdBits || 0, 0), edges: 0 };
  }

  step() {
    if (this.state === 'lobby' || this.state === 'result') return;
    this.eventsOut.length = 0;
    this.tick++;

    const racing = this.state === 'race';
    const frames = new Map();
    if (this.state === 'countdown' || racing) {
      for (const car of this.cars) {
        if (!car.isPlayer || car.auto || car.finished) continue;
        const f = this.consumeInput(car);
        frames.set(car.carId, f);
        const pressed = !!(f.edges & EDGE_BITS.up);
        if (!pressed) continue;
        if (this.state === 'countdown') {
          if (!car.startTried && this.tick > 326) { car.startTried = true; car.startBoostReady = true; }
        } else if (!car.startTried && this.raceTicks < 34) {
          car.startTried = true;
          this.applyStartBoost(car);
        } else car.startTried = true;
      }
    }

    if (this.state === 'countdown') {
      for (const n of [1, 120, 240, 360]) if (this.tick === n) this.emit({ type: 'cd', n: n === 1 ? 3 : n === 360 ? 0 : 3 - n / 120 });
      if (this.tick >= CD_TICKS) {
        this.state = 'race';
        for (const car of this.cars) {
          car.lapStart = 0;
          if (car.startBoostReady) this.applyStartBoost(car);
        }
        this.emit({ type: 'go' });
      }
    }

    const active = this.state === 'race';
    for (const car of this.cars) {
      if (car instanceof PlayerCar) {
        const f = frames.get(car.carId) || this.consumeInput(car);
        car.update(DT, f.frame, active, this.itemMode);
        if (f.edges & EDGE_BITS.reset) { if (active && !car.finished) this.resetCar(car); }
        if (this.itemMode && active && !car.finished && this.items) {
          if (f.edges & EDGE_BITS.nitro) this.items.use(car, this.standings);
          if (f.edges & EDGE_BITS.swap) this.items.swap(car);
        }
        this.collectEvents(car);
      } else {
        car.update(DT, active, this.raceTime, this.rubber(car));
      }
    }

    this.collide();
    for (const car of this.cars) this.updateProgress(car);
    this.updateStandings();
    if (this.items && active) {
      this.items.tick(DT, this.cars, this.standings);
      for (const c of this.cars) if (!c.isPlayer && !c.finished) this.items.aiThink(c, DT, this.cars, this.standings);
    }

    // 结算：全员完赛，或第一个人冲线后 10 秒
    if (this.firstFinish >= 0 && (this.cars.every((c) => c.finished) || this.raceTime - this.firstFinish > 10)) this.settle();
  }

  applyStartBoost(car) {
    car.startBoost = 1.4;
    car.s = Math.max(car.s, 16);
    this.emitCar(car, 'startBoost');
  }

  resetCar(car) {
    const s = this.track.sample(car.d, {});
    const keep = { lapsDone: car.lapsDone, owed: car.owed, half: car.half, lastD: car.d, gauge: car.gauge, nitroCount: car.nitroCount };
    car.reset(car.d, clamp(car.lat, -4, 4));
    Object.assign(car, keep);
    car.h = car.m = s.hd;
    car.s = 12;
    this.emitCar(car, 'reset');
  }

  collectEvents(car) {
    const st = car.stats;
    st.top = Math.max(st.top, car.speedKmh);
    for (const e of car.events) {
      if (e.type === 'driftStart') st.drift++;
      else if (e.type === 'smallBoost' || e.type === 'landBoost') { st.small++; if (e.data.perfect) st.perfect++; }
      else if (e.type === 'double') st.double++;
      else if (e.type === 'nitro') st.nitro++;
      else if (e.type === 'crash') st.crash++;
      this.emitCar(car, e.type, e.data);
    }
    car.events.length = 0;
  }

  emitCar(car, type, data) {
    this.eventsOut.push({ carId: car.carId, type, data });
  }

  emit(ev) { this.eventsOut.push({ carId: 0, ...ev }); }

  // ---------- 进度与名次 ----------
  updateProgress(car) {
    const L = this.track.length;
    if (car instanceof PlayerCar) {
      const d = car.d;
      if (car.lastD > 0.75 * L && d < 0.25 * L) {
        if (car.owed) { car.lapsDone++; car.owed = false; }
        else if (car.half) { car.lapsDone++; car.half = false; this.onLap(car); }
      } else if (car.lastD < 0.25 * L && d > 0.75 * L) {
        car.lapsDone--;
        car.owed = true;
      }
      if (d > 0.4 * L && d < 0.6 * L) car.half = true;
      car.lastD = d;
      car.progress = car.lapsDone * L + d;
    } else {
      const laps = Math.floor(car.dist / L);
      if (car.lapsDone !== undefined && laps > car.lapsDone && laps >= 1) { car.lapsDone = laps; this.onLap(car); }
      else car.lapsDone = laps;
      car.progress = car.dist;
    }
  }

  onLap(car) {
    if (this.state !== 'race') return;
    const t = this.raceTime - (car.lapStart || 0);
    car.lapStart = this.raceTime;
    car.lapTimes.push(t);
    if (car.lapsDone >= this.laps && !car.finished) {
      car.finished = true;
      car.finishTime = this.raceTime;
      if (this.firstFinish < 0) { this.firstFinish = this.raceTime; this.emit({ type: 'firstFinish', who: car.carId }); }
      this.emitCar(car, 'finish');
      return;
    }
    this.emitCar(car, 'lap');
  }

  updateStandings() {
    this.standings = [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    for (let i = 0; i < this.standings.length; i++) this.standings[i].place = i + 1;
  }

  racerAhead(car) {
    const i = this.standings.indexOf(car);
    return i > 0 ? this.standings[i - 1] : null;
  }

  // 橡皮筋：以领先者为基准，对所有人公平
  rubber(car) {
    const lead = this.standings[0];
    if (!lead) return 1;
    const gap = lead.progress - car.progress;
    if (gap > 0) return Math.max(this.diff.rubber[0], 1 - gap * 0.00045);
    return Math.min(this.diff.rubber[1], 1 + -gap * 0.0002);
  }

  settle() {
    if (this.state === 'result') return;
    this.state = 'result';
    this.updateStandings();
  }

  // ---------- 车-车碰撞（与单机版同一套算法） ----------
  collide() {
    const rs = this.cars;
    const R = 3.1;
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R || Math.abs(a.y - b.y) > 2.5) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d, nz = dz / d;
        const over = R - d;
        this.push(a, -nx * over * 0.5, -nz * over * 0.5);
        this.push(b, nx * over * 0.5, nz * over * 0.5);
        const va = this.velOf(a), vb = this.velOf(b);
        const rel = (vb[0] - va[0]) * nx + (vb[1] - va[1]) * nz;
        if (rel < 0) {
          const imp = -rel * 0.5;
          this.kick(a, -nx * imp, -nz * imp);
          this.kick(b, nx * imp, nz * imp);
          if (imp > 3) {
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + 0.6, mz = (a.z + b.z) / 2;
            this.emit({ type: 'bump', x: mx, y: my, z: mz, p: imp });
            // 被撞的一方各自收到一次，用来做本地震屏与音效（位置仍由服务器权威回滚修正）
            if (a.isPlayer && !a.auto) this.emitCar(a, 'bumpHit', { x: mx, y: my, z: mz, p: imp });
            if (b.isPlayer && !b.auto) this.emitCar(b, 'bumpHit', { x: mx, y: my, z: mz, p: imp });
          }
        }
      }
  }

  velOf(car) {
    if (car instanceof PlayerCar) return [Math.sin(car.m) * car.s, Math.cos(car.m) * car.s];
    const s = this.track.sample(car.dist, {});
    return [s.tx * car.s + s.rx * car.latV, s.tz * car.s + s.rz * car.latV];
  }

  push(car, px, pz) {
    if (car instanceof PlayerCar) { car.x += px; car.z += pz; return; }
    const s = this.track.sample(car.dist, {});
    car.lat += px * s.rx + pz * s.rz;
    car.pushD += px * s.tx + pz * s.tz;
  }

  kick(car, vx, vz) {
    if (car instanceof PlayerCar) {
      const cx = Math.sin(car.m) * car.s + vx, cz = Math.cos(car.m) * car.s + vz;
      const ns = Math.hypot(cx, cz);
      if (car.s >= 0 && ns > 0.5) { car.s = ns; car.m = Math.atan2(cx, cz); }
      return;
    }
    const s = this.track.sample(car.dist, {});
    car.s = Math.max(0, car.s + vx * s.tx + vz * s.tz);
    car.latV += vx * s.rx + vz * s.rz;
  }

  hitRacer(car, kind) {
    if (applyHit(car, kind) === 'shield') { this.emitCar(car, 'shieldHit'); return; }
    this.emitCar(car, kind === 'missile' ? 'missiled' : 'banana');
  }

  // 输入 tick 对齐：希望输入在目标 tick = 客户端 tick + bias 处，比到达时刻晚 car.delay tick
  // 死区 ±2 tick 的慢速控制器，自动吸收网络抖动与时钟漂移
  updateBias(car, clientTick, nowTick) {
    const e = nowTick + car.delay - (clientTick + car.bias);
    if (e > 2) car.bias += Math.min(4, Math.ceil(e / 2));
    else if (e < -2) car.bias -= Math.min(4, Math.ceil(-e / 2));
  }

  snapshotFields(car) {
    return {
      carId: car.carId,
      x: car.x, y: car.y, z: car.z,
      h: car.h, m: car.m ?? car.h, s: car.s,
      drifting: !!car.drifting,
      airborne: !!car.airborne,
      nitro: car.nitroTime > 0,
      small: car.smallBoost > 0 || car.padTime > 0 || car.startBoost > 0,
      spin: car.spin > 0,
      shield: car.shield > 0,
      gauge: car.gauge || 0,
      nitroCount: car.nitroCount || 0,
      progress: car.progress || 0,
      lap: Math.max(0, (car.lapsDone || 0) + 1),
      place: car.place || 0,
      finished: !!car.finished,
      items: car.items || [],
      ackTick: car.isPlayer ? this.tick - car.bias : 0,
    };
  }
}

// 服务端自动驾驶（掉线/完赛后），直接产出 PlayerCar 需要的输入位图
function autopilotFrame(track, car) {
  const s = track.sample(car.d + 18, {});
  const e = wrapAngle(Math.atan2(s.x - car.x, s.z - car.z) - car.h);
  let bits = HOLD_BITS.up;
  if (e > 0.04) bits |= HOLD_BITS.left;
  else if (e < -0.04) bits |= HOLD_BITS.right;
  if (Math.abs(car.s) > 38) bits &= ~HOLD_BITS.up;
  return frameFromBits(bits, 0);
}
