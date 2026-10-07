// 道具表现层（three 网格）；规则全部来自 shared/items.js，单机与联机共用同一套判定
import * as THREE from 'three';
import { textTexture } from './textures.js';
import { ItemsLogic } from '../shared/items.js';

const QUESTION = { t: null };
function questionTex() {
  if (!QUESTION.t) {
    QUESTION.t = textTexture('?', { w: 128, h: 128, bg: null, fg: '#ffffff', font: '900 110px Arial Black, Arial', stroke: '#1d4fb0' });
  }
  return QUESTION.t;
}

export function makeBoxProto() {
  const g = new THREE.Group();
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x55c8ff, emissive: 0x1d6ff2, emissiveIntensity: 0.6, transparent: true, opacity: 0.85, roughness: 0.2, metalness: 0.3 });
  const qMat = new THREE.MeshBasicMaterial({ map: questionTex(), transparent: true, depthWrite: false, side: THREE.DoubleSide });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), boxMat));
  for (const r of [0, Math.PI / 2]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), qMat);
    q.rotation.y = r;
    g.add(q);
  }
  return g;
}

export function makeBananaMesh() {
  const m = new THREE.Group();
  const peel = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.22, 8, 16, Math.PI * 1.3), new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.5, emissive: 0x332a00 }));
  peel.rotation.x = Math.PI / 2;
  m.add(peel);
  for (let k = 0; k < 3; k++) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.7, 6), peel.material);
    leaf.position.set(Math.cos(k * 2.1) * 0.5, 0.1, Math.sin(k * 2.1) * 0.5);
    leaf.rotation.z = Math.PI / 2;
    leaf.rotation.y = k * 2.1;
    m.add(leaf);
  }
  m.scale.setScalar(1.4);
  return m;
}

export function makeMissileMesh() {
  const m = new THREE.Group();
  const geo = new THREE.CylinderGeometry(0.22, 0.22, 1.6, 10);
  geo.rotateX(Math.PI / 2);
  m.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.3 })));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 10), new THREE.MeshStandardMaterial({ color: 0xff3030 }));
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 1.05;
  m.add(nose);
  return m;
}

// 把 ItemsLogic 的实体状态映射到网格：单机用逐步演算结果，联机用服务器权威快照
export class ItemMeshes {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.boxProto = makeBoxProto();
    this.boxMeshes = [];
    this.missiles = new Map();
    this.bananas = new Map();
    this.t = 0;
  }

  placeBoxes(boxes) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const g = i === 0 ? this.boxProto : this.boxProto.clone();
      g.position.set(b.x, b.y, b.z);
      this.group.add(g);
      this.boxMeshes.push(g);
    }
  }

  sync(boxes, missiles, bananas, dt, fx) {
    this.t += dt;
    for (let i = 0; i < this.boxMeshes.length; i++) {
      const g = this.boxMeshes[i];
      const b = boxes[i];
      if (!b) { g.visible = false; continue; }
      g.visible = b.respawn <= 0;
      g.rotation.y = this.t * 1.6;
      g.rotation.x = Math.sin(this.t * 1.3) * 0.25;
      g.position.y = b.y + Math.sin(this.t * 2 + b.x) * 0.2;
    }
    this.syncSet(this.missiles, missiles, makeMissileMesh, (mesh, e) => {
      mesh.position.set(e.x, e.y, e.z);
      const dx = e.dx !== undefined ? e.dx : Math.sin(e.yaw || 0);
      const dz = e.dz !== undefined ? e.dz : Math.cos(e.yaw || 0);
      const dy = e.dy || 0;
      mesh.lookAt(mesh.position.x + dx, mesh.position.y + dy, mesh.position.z + dz);
      if (fx && fx.trail) fx.trail(e.x - dx, e.y, e.z - dz);
    });
    this.syncSet(this.bananas, bananas, makeBananaMesh, (mesh, e) => {
      mesh.position.set(e.x, e.y, e.z);
      mesh.rotation.y += dt;
    });
  }

  syncSet(pool, list, make, apply) {
    const live = new Set();
    for (const e of list) {
      live.add(e.id);
      let mesh = pool.get(e.id);
      if (!mesh) {
        mesh = make();
        this.group.add(mesh);
        pool.set(e.id, mesh);
      }
      apply(mesh, e);
    }
    for (const [id, mesh] of pool) {
      if (live.has(id)) continue;
      this.group.remove(mesh);
      pool.delete(id);
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.missiles.clear();
    this.bananas.clear();
    this.boxMeshes = [];
  }
}

// 单机完整实现：规则 + 表现，对外 API 与改造前一致
export class ItemSystem {
  constructor(scene, track, game, rnd) {
    this.game = game;
    this.track = track;
    const seed = (Math.floor(rnd() * 0xffffffff) >>> 0) || 7;
    this.logic = new ItemsLogic(track, seed, {
      hitRacer: (car, kind) => game.hitRacer(car, kind),
      racerAhead: (car) => game.racerAhead(car),
      onMissileLock: (target) => { if (target && target.isPlayer) game.onMissileLock(); },
      onGrant: (car, item, box) => {
        if (car.isPlayer) game.onItemGet(item);
        game.fx.burst(box.x, box.y, box.z, 0x55c8ff);
      },
      onUse: (car, item) => game.sfx(item === 'missile' ? 'missile' : item === 'banana' ? 'banana' : 'item', car),
    });
    this.meshes = new ItemMeshes(scene);
    this.meshes.placeBoxes(this.logic.boxes);
    this.standings = [];
  }

  reset() {
    this.logic.reset();
  }

  dispose() {
    this.meshes.dispose();
  }

  update(dt, racers, standings) {
    this.standings = standings;
    this.logic.tick(dt, racers, standings);
    this.meshes.sync(this.logic.boxes, this.logic.missiles, this.logic.bananas, dt, this.game.fx);
  }

  use(car) {
    return this.logic.use(car, this.standings);
  }

  swap(car) {
    this.logic.swap(car);
  }

  aiThink(car, dt, standings) {
    return this.logic.aiThink(car, dt, this.game.racers, standings || this.standings);
  }
}
