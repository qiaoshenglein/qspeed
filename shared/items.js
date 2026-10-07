// 道具规则层：纯数据与判定，无渲染依赖。单机、服务器、联机客户端表现层共用同一份规则。
import { mulberry32 } from './util.js';

const WEIGHTS = {
  lead: { banana: 35, shield: 30, nitro: 20, missile: 10, magnet: 5 },
  mid: { missile: 25, nitro: 25, banana: 20, magnet: 15, shield: 15 },
  back: { missile: 32, nitro: 30, magnet: 25, shield: 10, banana: 3 },
};

export const ITEM_CODE = { none: 0, banana: 1, shield: 2, nitro: 3, missile: 4, magnet: 5 };
export const ITEM_NAME = Object.fromEntries(Object.entries(ITEM_CODE).map(([k, v]) => [v, k]));

export const BOX_L = [0.1, 0.35, 0.6, 0.85];
export const BOX_LAT = [-0.6, -0.3, 0, 0.3, 0.6];
export const BOX_RESPAWN = 2.5;

function pick(w, rnd) {
  let tot = 0;
  for (const k in w) tot += w[k];
  let r = rnd() * tot;
  for (const k in w) {
    r -= w[k];
    if (r <= 0) return k;
  }
  return 'nitro';
}

export class ItemsLogic {
  // hooks: { hitRacer(car, kind), racerAhead(car), onGrant(item), onUse(car, item) }
  constructor(track, seed, hooks = {}) {
    this.track = track;
    this.rnd = mulberry32((seed >>> 0) || 7);
    this.hooks = hooks;
    this.boxes = [];
    this.missiles = [];
    this.bananas = [];
    this.nextId = 1;
    const hw = track.halfW;
    for (const f of BOX_L) {
      const d = f * track.length;
      const s = track.sample(d, {});
      for (const lat of BOX_LAT) {
        const L = lat * hw;
        this.boxes.push({
          x: s.x + s.rx * L,
          y: s.y + L * Math.sin(s.bank) + 1.6,
          z: s.z + s.rz * L,
          respawn: 0,
        });
      }
    }
  }

  reset() {
    for (const b of this.boxes) b.respawn = 0;
    this.missiles.length = 0;
    this.bananas.length = 0;
  }

  giveRandom(car, rank, total) {
    if (!car.items) car.items = [];
    if (car.items.length >= 2) return null;
    const w = rank === 1 ? WEIGHTS.lead : rank >= total - 1 ? WEIGHTS.back : WEIGHTS.mid;
    const it = pick(w, this.rnd);
    car.items.push(it);
    return it;
  }

  swap(car) {
    if (car.items && car.items.length === 2) car.items.reverse();
  }

  // 使用道具：只有权威端调用；返回事件名给上层做表现
  use(car, standings) {
    if (!car.items || !car.items.length) return null;
    const it = car.items.shift();
    switch (it) {
      case 'nitro':
        if (car.triggerNitro) car.triggerNitro(true);
        else car.nitroTime = 2.6;
        break;
      case 'shield':
        car.shield = 7;
        break;
      case 'magnet':
        car.magnet = 3;
        car.magnetTarget = this.hooks.racerAhead ? this.hooks.racerAhead(car, standings) : null;
        break;
      case 'banana': {
        const bx = car.x - Math.sin(car.h) * 3.2, bz = car.z - Math.cos(car.h) * 3.2;
        const p = this.track.project(bx, car.y, bz, car.hint || -1, {});
        this.bananas.push({ id: this.nextId++, x: bx, y: p.y + p.lat * Math.sin(p.bank) + 0.25, z: bz, age: 0, ownerId: car.carId });
        break;
      }
      case 'missile': {
        const target = this.hooks.racerAhead ? this.hooks.racerAhead(car, standings) : null;
        this.missiles.push({
          id: this.nextId++, x: car.x, y: car.y + 1.8, z: car.z,
          dx: Math.sin(car.h), dy: 0, dz: Math.cos(car.h),
          v: Math.max(80, Math.abs(car.s) + 30), life: 6,
          ownerId: car.carId, targetId: target ? target.carId : 0,
        });
        this.hooks.onMissileLock && this.hooks.onMissileLock(target, car);
        break;
      }
      default:
        return null;
    }
    this.hooks.onUse && this.hooks.onUse(car, it);
    return it;
  }

  tick(dt, cars, standings) {
    // 道具箱
    for (const b of this.boxes) {
      if (b.respawn > 0) {
        b.respawn -= dt;
        continue;
      }
      for (const car of cars) {
        const dx = car.x - b.x, dz = car.z - b.z, dy = car.y + 0.8 - b.y;
        if (dx * dx + dz * dz < 6.5 && Math.abs(dy) < 3) {
          b.respawn = BOX_RESPAWN;
          const rank = standings.indexOf(car) + 1;
          const got = this.giveRandom(car, rank, cars.length);
          this.hooks.onGrant && this.hooks.onGrant(car, got, b);
          break;
        }
      }
    }

    // 香蕉皮
    for (let i = this.bananas.length - 1; i >= 0; i--) {
      const bn = this.bananas[i];
      bn.age += dt;
      let hit = null;
      for (const car of cars) {
        if (car.carId === bn.ownerId && bn.age < 1.2) continue;
        const dx = car.x - bn.x, dz = car.z - bn.z;
        if (dx * dx + dz * dz < 4.4 && Math.abs(car.y - bn.y) < 2.5) { hit = car; break; }
      }
      if (hit || bn.age > 90) {
        if (hit) this.hooks.hitRacer(hit, 'banana');
        this.bananas.splice(i, 1);
      }
    }

    // 导弹
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= dt;
      const target = m.targetId ? cars.find((c) => c.carId === m.targetId) : null;
      if (target && !target.finished) {
        const tx = target.x - m.x, ty = target.y + 0.8 - m.y, tz = target.z - m.z;
        const dist = Math.hypot(tx, ty, tz) || 1;
        const k = Math.min(1, dt * 6);
        m.dx += (tx / dist - m.dx) * k;
        m.dy += (ty / dist - m.dy) * k;
        m.dz += (tz / dist - m.dz) * k;
        const n = Math.hypot(m.dx, m.dy, m.dz) || 1;
        m.dx /= n; m.dy /= n; m.dz /= n;
        m.v = Math.max(m.v, Math.abs(target.s) + 35);
        if (dist < 2.6) {
          this.hooks.hitRacer(target, 'missile', m);
          this.missiles.splice(i, 1);
          continue;
        }
      }
      m.x += m.dx * m.v * dt;
      m.y += m.dy * m.v * dt;
      m.z += m.dz * m.v * dt;
      if (m.life <= 0) this.missiles.splice(i, 1);
    }
  }

  // 电脑用道具的简单决策（与单机一致）
  aiThink(car, dt, cars, standings) {
    if (!car.items || !car.items.length) return null;
    car.itemTimer -= dt;
    if (car.itemTimer > 0) return null;
    car.itemTimer = 1 + this.rnd() * 3;
    const it = car.items[0];
    const ahead = this.hooks.racerAhead ? this.hooks.racerAhead(car, standings) : null;
    const gap = ahead ? ahead.progress - car.progress : 1e9;
    if (it === 'missile' && (!ahead || gap > 350)) { if (car.items.length > 1) this.swap(car); return null; }
    if (it === 'magnet' && (!ahead || gap > 150)) return null;
    return this.use(car, standings);
  }
}
