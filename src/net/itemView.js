// 联机道具表现：按服务器权威实体驱动，导弹在两个快照之间用速度外推，避免 20Hz 抖动
import { ItemsLogic } from '../../shared/items.js';
import { ItemMeshes } from '../items.js';

export class NetItemView {
  constructor(scene, track) {
    // 只借用规则层的箱子摆位公式（两端同公式，不需要网络传坐标）
    this.geo = new ItemsLogic(track, 1);
    this.meshes = new ItemMeshes(scene);
    this.meshes.placeBoxes(this.geo.boxes);
    this.missiles = [];
    this.bananas = [];
  }

  update(dt, snapItems) {
    if (!snapItems) {
      this.meshes.sync(this.geo.boxes, [], [], dt, null);
      return;
    }
    const mask = snapItems.mask >>> 0;
    for (let i = 0; i < this.geo.boxes.length; i++) {
      const on = (mask & (1 << i)) !== 0;
      this.geo.boxes[i].respawn = on ? 0 : 0.01;
    }
    const seen = new Map();
    for (const m of snapItems.missiles) {
      const dx = Math.sin(m.yaw), dz = Math.cos(m.yaw);
      let e = this.missiles.find((x) => x.id === m.id);
      if (!e) {
        e = { id: m.id, x: m.x, y: m.y, z: m.z, dx, dy: m.dy, v: m.v, targetId: m.targetId };
        this.missiles.push(e);
      } else {
        // 权威位置纠正（外推与真实飞行之间的偏差通常很小）
        e.x = m.x; e.y = m.y; e.z = m.z; e.dx = dx; e.dy = m.dy; e.v = m.v; e.targetId = m.targetId;
      }
      seen.set(e.id, e);
      e.x += e.dx * e.v * dt;
      e.y += e.dy * e.v * dt;
      e.z += e.dz * e.v * dt;
    }
    this.missiles = this.missiles.filter((m) => seen.has(m.id));

    const bseen = new Set();
    for (const b of snapItems.bananas) {
      bseen.add(b.id);
      let e = this.bananas.find((x) => x.id === b.id);
      if (!e) this.bananas.push((e = { id: b.id, x: b.x, y: b.y, z: b.z }));
      else { e.x = b.x; e.y = b.y; e.z = b.z; }
    }
    this.bananas = this.bananas.filter((b) => bseen.has(b.id));

    this.meshes.sync(this.geo.boxes, this.missiles, this.bananas, dt, null);
  }

  // 道具箱世界坐标（拾取特效用）
  boxPos(i) {
    const b = this.geo.boxes[i];
    return b ? { x: b.x, y: b.y, z: b.z } : null;
  }

  dispose() {
    this.meshes.dispose();
  }
}
