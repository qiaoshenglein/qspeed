// 浏览器侧联网层：把 NetCore 的权威状态变成场景里的车模（本车 + 他车插值）
import { NetCore, INTERP_DELAY_MS, PHASE } from '../../shared/session.js';
import { buildCar, CAR_SKINS } from '../carModel.js';
import { damp, clamp, wrapAngle } from '../../shared/util.js';
import { F } from '../../shared/proto.js';

export class NetClient extends NetCore {
  constructor(opts) {
    super(opts);
    this.models = new Map(); // carId -> RemoteView
    this.onRemote = opts.onRemote || null;
  }

  applySnap(snap) {
    super.applySnap(snap);
    for (const [carId, st] of this.remote) {
      if (!this.models.has(carId)) {
        const view = new RemoteView(carId, this.track, st.name, st.skin);
        this.models.set(carId, view);
        if (this.opts.scene) this.opts.scene.add(view.model);
      }
    }
    for (const [carId, view] of this.models) {
      if (!this.remote.has(carId)) {
        if (this.opts.scene) this.opts.scene.remove(view.model);
        view.dispose();
        this.models.delete(carId);
      }
    }
  }

  // 本车：物理预测 + 对账偏移衰减
  syncOwn(dt) {
    const c = this.me;
    if (!c) return;
    c.syncModel(dt);
    if (this.visual.t > 0) {
      c.model.position.x += this.visual.x;
      c.model.position.z += this.visual.z;
      c.model.rotation.y += this.visual.h;
    }
  }

  syncRemote(dt, camPos) {
    const renderAt = performance.now() - INTERP_DELAY_MS;
    for (const [carId, view] of this.models) {
      const st = this.remote.get(carId);
      if (!st) continue;
      const s = this.interpState(st, renderAt);
      if (s) view.render(s, dt, camPos);
    }
  }

  dispose() {
    for (const view of this.models.values()) {
      if (this.opts.scene) this.opts.scene.remove(view.model);
      view.dispose();
    }
    this.models.clear();
    super.dispose();
  }
}

class RemoteView {
  constructor(carId, track, name, skin) {
    this.carId = carId;
    this.track = track;
    this.name = name || '对手';
    this.skinIdx = skin >= 0 ? skin % CAR_SKINS.length : carId % CAR_SKINS.length;
    this.model = buildCar(CAR_SKINS[this.skinIdx], { name: this.name });
    this.pitch = 0;
    this.roll = 0;
    this.proj = {};
    this.hint = -1;
    this.prevH = null;
  }

  render(s, dt, camPos) {
    this.x = s.x; this.y = s.y; this.z = s.z; this.h = s.h; this.s = s.s; this.flags = s.flags;
    const p = this.track.project(s.x, s.y + 0.4, s.z, this.hint, this.proj);
    this.hint = p.i;
    const rel = wrapAngle(s.h - p.hd);
    const slopeAlong = this.track.slope[p.i] * Math.cos(rel);
    const bankAlong = (this.track.bank[p.i] ?? 0) * Math.cos(rel);
    const airborne = !!(s.flags & F.airborne);
    this.pitch = damp(this.pitch, airborne ? -0.08 : -Math.atan(slopeAlong), 10, dt);
    this.roll = damp(this.roll, -bankAlong, 10, dt);

    const m = this.model;
    m.position.set(s.x, Math.max(s.y, p.surfY ?? s.y), s.z);
    m.rotation.set(this.pitch, s.h, this.roll, 'YXZ');
    const u = m.userData;
    const drifting = !!(s.flags & F.drifting);
    u.root.rotation.z = damp(u.root.rotation.z, drifting ? 0.06 * (rel >= 0 ? 1 : -1) : 0, 8, dt);
    for (const w of u.wheels) {
      w.spin.rotation.x += (s.s * dt) / 0.47;
      if (w.front) w.steer.rotation.y = drifting ? -0.3 : clamp(rel * 2, -0.38, 0.38);
    }
    const nitro = !!(s.flags & F.nitro), small = !!(s.flags & F.small);
    if (u.shield) u.shield.visible = !!(s.flags & F.shield);
    for (const f of u.flames) f.visible = nitro || small;
    if (camPos) {
      const far = (s.x - camPos.x) ** 2 + (s.z - camPos.z) ** 2 > 340 * 340;
      m.visible = !far;
    }
  }

  dispose() {
    this.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
}

export { PHASE, NetCore };
