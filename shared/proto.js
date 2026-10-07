// 二进制协议：位定点量化，6 台车一帧快照约 210 字节 @20Hz ≈ 4KB/s
import { clamp } from './util.js';

// 消息类型
export const C = { // client -> server
  HELLO: 1, JOIN: 2, QUICK: 3, READY: 4, INPUT: 5, PING: 6, LEAVE: 7,
};
export const S = { // server -> client
  WELCOME: 10, ROSTER: 11, SNAP: 12, EV: 13, RESULT: 14, PONG: 15, ERR: 16, ROOM: 17,
};

export const PHASE = { lobby: 0, countdown: 1, race: 2, result: 3 };

export const EV = {
  cd: 1, go: 2, nitro: 3, smallBoost: 4, landBoost: 5, double: 6, gaugeFull: 7,
  crash: 8, scrape: 9, land: 10, pad: 11, lap: 12, finish: 13, reset: 14,
  startBoost: 15, bump: 16, firstFinish: 17, driftStart: 18, driftEnd: 19,
  shieldHit: 20, missiled: 21, banana: 22, itemGet: 23, itemUse: 24, missileBoom: 25, missileLock: 26, bumpHit: 27,
};
const EV_NAME = Object.fromEntries(Object.entries(EV).map(([k, v]) => [v, k]));

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Writer {
  constructor(cap = 256) { this.buf = new DataView(new ArrayBuffer(cap)); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(new Uint8Array(this.buf.buffer, 0, this.len));
    this.buf = new DataView(nb);
  }
  u8(v) { this.ensure(1); this.buf.setUint8(this.len, v); this.len += 1; return this; }
  u16(v) { this.ensure(2); this.buf.setUint16(this.len, v, true); this.len += 2; return this; }
  i16(v) { this.ensure(2); this.buf.setInt16(this.len, v, true); this.len += 2; return this; }
  u32(v) { this.ensure(4); this.buf.setUint32(this.len, v, true); this.len += 4; return this; }
  i32(v) { this.ensure(4); this.buf.setInt32(this.len, v, true); this.len += 4; return this; }
  f32(v) { this.ensure(4); this.buf.setFloat32(this.len, v, true); this.len += 4; return this; }
  angle(a) { return this.u16(Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) * 65536 / (Math.PI * 2)) & 0xffff); }
  fixed(v, q) { return this.i32(Math.round(v / q)); }
  str(s) {
    const b = enc.encode(String(s ?? '').slice(0, 24));
    this.u8(b.length);
    this.ensure(b.length);
    new Uint8Array(this.buf.buffer, this.len, b.length).set(b);
    this.len += b.length;
    return this;
  }
  bytes() { return new Uint8Array(this.buf.buffer, 0, this.len); }
}

export class Reader {
  constructor(data) {
    this.buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.len = this.buf.byteLength;
    this.pos = 0;
  }
  u8() { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  angle() { return (this.u16() / 65536) * Math.PI * 2; }
  fixed(q) { return this.i32() * q; }
  str() { const n = this.u8(); const s = dec.decode(this.buf.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
  get eof() { return this.pos >= this.len; }
}

export const Q = { pos: 1 / 64, spd: 1 / 64, prog: 1 / 64, time: 1 / 100 };

// 车辆标志位（快照 flags）
export const F = {
  drifting: 1, airborne: 2, nitro: 4, small: 8, spin: 16, shield: 32,
  finished: 64, auto: 128,
};

const ITEM_CODE = { none: 0, banana: 1, shield: 2, nitro: 3, missile: 4, magnet: 5 };
export const ITEM_NAME = Object.fromEntries(Object.entries(ITEM_CODE).map(([k, v]) => [v, k]));

export function encodeSnapshot(world, tick, phaseNum) {
  const items = world.items || null;
  const w = new Writer(64 + world.cars.length * 40 + (items ? 12 + items.missiles.length * 18 + items.bananas.length * 14 : 0));
  w.u8(S.SNAP).u32(tick).u8(phaseNum).u8(world.cars.length);
  for (const car of world.cars) {
    const f = world.snapshotFields(car);
    let flags = 0;
    if (f.drifting) flags |= F.drifting;
    if (f.airborne) flags |= F.airborne;
    if (f.nitro) flags |= F.nitro;
    if (f.small) flags |= F.small;
    if (f.spin) flags |= F.spin;
    if (f.shield) flags |= F.shield;
    if (f.finished) flags |= F.finished;
    if (car.auto) flags |= F.auto;
    w.u16(f.carId)
      .fixed(f.x, Q.pos).fixed(f.z, Q.pos)
      .i16(Math.round(f.y / Q.pos))
      .angle(f.h).angle(f.m)
      .i16(Math.round(clamp(f.s, -512, 512) / Q.spd))
      .u16(flags)
      .u8(Math.round(clamp(f.gauge, 0, 1) * 100))
      .u8(Math.min(3, f.nitroCount | 0))
      .fixed(f.progress, Q.prog)
      .u8(clampI(f.lap, 63)).u8(clampI(f.place, 63))
      .u8(ITEM_CODE[f.items[0]] ?? 0).u8(ITEM_CODE[f.items[1]] ?? 0)
      .u32(f.ackTick);
  }
  // 道具实体：位置由权威端给出；道具箱位置两端同公式推导，只传可见位图
  w.u8(items ? 1 : 0);
  if (items) {
    w.u8(items.missiles.length).u8(items.bananas.length);
    let mask = 0;
    for (let i = 0; i < items.boxes.length; i++) if (items.boxes[i].respawn <= 0) mask |= (1 << i);
    w.u32(mask);
    for (const m of items.missiles) {
      w.u16(m.id).fixed(m.x, Q.pos).fixed(m.z, Q.pos).i16(Math.round(m.y / Q.pos))
        .u16(Math.round(((Math.atan2(m.dx, m.dz) + Math.PI) / (Math.PI * 2)) * 65535))
        .u8(clamp(Math.round(m.dy * 40), -127, 127) & 0xff)
        .u8(clamp(Math.round(m.v / 2), 0, 255)).u16(m.targetId);
    }
    for (const b of items.bananas) {
      w.u16(b.id).fixed(b.x, Q.pos).fixed(b.z, Q.pos).i16(Math.round(b.y / Q.pos));
    }
  }
  return w.bytes();
}

const clampI = (v, m) => Math.max(-m, Math.min(m, Math.round(v || 0)));
const itemName = (code) => (code > 0 ? ITEM_NAME[code] : null) || null;

export function decodeSnapshot(r) {
  const tick = r.u32();
  const phase = r.u8();
  const n = r.u8();
  const racers = [];
  for (let i = 0; i < n; i++) {
    racers.push({
      carId: r.u16(),
      x: r.fixed(Q.pos), z: r.fixed(Q.pos),
      y: r.i16() * Q.pos,
      h: r.angle(), m: r.angle(),
      s: r.i16() * Q.spd,
      flags: r.u16(),
      gauge: r.u8() / 100,
      nitroCount: r.u8(),
      progress: r.fixed(Q.prog),
      lap: r.u8(), place: r.u8(),
      items: [itemName(r.u8()), itemName(r.u8())],
      ackTick: r.u32(),
    });
  }
  let items = null;
  if (!r.eof && r.u8()) {
    const nm = r.u8(), nb = r.u8();
    const mask = r.u32();
    const missiles = [];
    for (let i = 0; i < nm; i++) {
      const id = r.u16();
      const x = r.fixed(Q.pos), z = r.fixed(Q.pos), y = r.i16() * Q.pos;
      const yaw = (r.u16() / 65535) * Math.PI * 2 - Math.PI;
      const raw = r.u8();
      const dy = (raw > 127 ? raw - 256 : raw) / 40;
      missiles.push({ id, x, y, z, yaw, dy, v: r.u8() * 2, targetId: r.u16() });
    }
    const bananas = [];
    for (let i = 0; i < nb; i++) bananas.push({ id: r.u16(), x: r.fixed(Q.pos), z: r.fixed(Q.pos), y: r.i16() * Q.pos });
    items = { missiles, bananas, mask };
  }
  return { tick, phase, racers, items };
}

export function encodeEvents(events) {
  const w = new Writer(16 + events.length * 16);
  w.u8(S.EV).u8(Math.min(events.length, 255));
  for (const ev of events.slice(0, 255)) {
    w.u16(ev.carId || 0).u8(EV[ev.type] || 0);
    const d = ev.data || {};
    if (ev.type === 'cd') w.u8(ev.n);
    else if (ev.type === 'bump') w.fixed(ev.x, Q.pos).fixed(ev.z, Q.pos).i16(Math.round((ev.y || 0) / Q.pos));
    else if (ev.type === 'crash') w.fixed(d.x, Q.pos).fixed(d.z, Q.pos).u8(clampI(d.power, 255));
    else if (ev.type === 'scrape') w.fixed(d.x, Q.pos).fixed(d.z, Q.pos);
    else if (ev.type === 'driftEnd') w.u8(Math.round(clampI(d.time * 4, 255)));
    else if (ev.type === 'land') w.u8(Math.round(clampI(d.air * 10, 255)));
    else if (ev.type === 'smallBoost' || ev.type === 'landBoost') w.u8((d.perfect ? 1 : 0) | (d.double ? 2 : 0));
    else if (ev.type === 'itemGet') w.u8(ev.box | 0).u8(ITEM_CODE[ev.kind] || 0);
    else if (ev.type === 'itemUse') w.u8(ev.kind | 0);
    else if (ev.type === 'missileLock') w.u16(ev.who | 0);
    else if (ev.type === 'bumpHit') { const d = ev.data || {}; w.fixed(d.x || 0, Q.pos).fixed(d.z || 0, Q.pos).i16(Math.round((d.y || 0) / Q.pos)).u8(clampI(d.p, 255)); }
  }
  return w.bytes();
}

export function decodeEvents(r) {
  const n = r.u8();
  const out = [];
  for (let i = 0; i < n; i++) {
    const carId = r.u16();
    const typeId = r.u8();
    const type = EV_NAME[typeId] || 'unknown';
    const ev = { carId, type };
    if (type === 'cd') ev.n = r.u8();
    else if (type === 'bump') { ev.x = r.fixed(Q.pos); ev.z = r.fixed(Q.pos); ev.y = r.i16() * Q.pos; }
    else if (type === 'crash') { ev.x = r.fixed(Q.pos); ev.z = r.fixed(Q.pos); ev.power = r.u8(); }
    else if (type === 'scrape') { ev.x = r.fixed(Q.pos); ev.z = r.fixed(Q.pos); }
    else if (type === 'driftEnd') ev.time = r.u8() / 4;
    else if (type === 'land') ev.air = r.u8() / 10;
    else if (type === 'smallBoost' || type === 'landBoost') { const b = r.u8(); ev.perfect = !!(b & 1); ev.double = !!(b & 2); }
    else if (type === 'itemGet') { ev.box = r.u8(); ev.kind = itemName(r.u8()); }
    else if (type === 'itemUse') ev.kind = itemName(r.u8());
    else if (type === 'missileLock') ev.who = r.u16();
    else if (type === 'bumpHit') { ev.x = r.fixed(Q.pos); ev.z = r.fixed(Q.pos); ev.y = r.i16() * Q.pos; ev.p = r.u8(); }
    out.push(ev);
  }
  return out;
}

export function encodeRoster(players, extra = 0) {
  const w = new Writer(32 + players.length * 40);
  w.u8(S.ROSTER).u8(extra).u8(players.length);
  for (const p of players) {
    w.u16(p.carId).u8(p.slot).u8(p.skin).u8((p.bot ? 1 : 0) | (p.online ? 2 : 0) | (p.ready ? 4 : 0)).str(p.name);
  }
  return w.bytes();
}

export function decodeRoster(r) {
  const extra = r.u8();
  const n = r.u8();
  const list = [];
  for (let i = 0; i < n; i++) {
    const carId = r.u16(), slot = r.u8(), skin = r.u8(), bits = r.u8();
    list.push({ carId, slot, skin, bot: !!(bits & 1), online: !!(bits & 2), ready: !!(bits & 4), name: r.str() });
  }
  return { extra, list };
}

export function encodeResult(world) {
  const w = new Writer(64 + world.cars.length * 40);
  w.u8(S.RESULT).u8(world.cars.length);
  for (const car of world.standings) {
    const best = car.lapTimes.length ? Math.min(...car.lapTimes) : 0;
    w.u16(car.carId).u8(car.finished ? 1 : 0).f32(car.finishTime || 0).f32(best)
      .u8(Math.max(0, car.lapsDone || 0))
      .u16(clampI(car.stats?.drift, 65535)).u16(clampI(car.stats?.small, 65535))
      .u16(clampI(car.stats?.perfect, 65535)).u16(clampI(car.stats?.double, 65535))
      .u16(clampI(car.stats?.nitro, 65535)).u16(clampI(car.stats?.top / 3.6, 65535))
      .u16(clampI(car.stats?.crash, 65535));
  }
  return w.bytes();
}

export function decodeResult(r) {
  const n = r.u8();
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      carId: r.u16(), finished: !!r.u8(), time: r.f32(), best: r.f32(), laps: r.u8(),
      stats: { drift: r.u16(), small: r.u16(), perfect: r.u16(), double: r.u16(), nitro: r.u16(), top: r.u16() * 3.6, crash: r.u16() },
    });
  }
  return rows;
}

// 输入包：baseTick 起连续 n 个仿真 tick，每个 tick 一组 (按住位图, 边沿位图)
// 按住 up1 down2 left4 right8 shift16 · 边沿 up1 w2 nitro4 swap8 reset16
export function encodeInput(seq, baseTick, subs) {
  const w = new Writer(8 + subs.length * 2);
  w.u8(C.INPUT).u16(seq).u32(baseTick).u8(subs.length);
  for (const s of subs) w.u8(s[0]).u8(s[1]);
  return w.bytes();
}

export function decodeInput(r) {
  const seq = r.u16();
  const baseTick = r.u32();
  const n = r.u8();
  const subs = [];
  for (let i = 0; i < n; i++) subs.push([r.u8(), r.u8()]);
  return { seq, baseTick, subs };
}
