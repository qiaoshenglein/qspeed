// 赛道仿真内核：纯数据表 + 采样/投影，不依赖 three。
// 客户端渲染层（src/track.js）与服务端权威仿真共用这一份，保证两端几何完全一致。
import { clamp, wrapAngle } from './util.js';
import { CatmullRomClosed } from './catmull.js';

export class TrackSim {
  constructor(layout, cfg = {}) {
    this.halfW = layout.width / 2;
    this.wallH = cfg.wallH ?? 1.25;
    this.grip = cfg.grip ?? 1; // 路面抓地力倍率（湿滑地图 <1）：两端必须取同一个值
    // 控制点 [x, z, y] → 世界坐标 (x, y, z)
    const curve = new CatmullRomClosed(layout.points.map((p) => ({ x: p[0], y: p[2] || 0, z: p[1] })), 6000);
    const approxLen = curve.getLength();
    const N = Math.round(approxLen / 1.5);
    const pts = curve.getSpacedPoints(N).slice(0, N);
    this.N = N;
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.px[i] = pts[i].x;
      this.py[i] = pts[i].y;
      this.pz[i] = pts[i].z;
    }
    let len = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      len += Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]);
    }
    this.length = len;
    this.ds = len / N;

    this.hd = new Float32Array(N);
    this.tx = new Float32Array(N);
    this.tz = new Float32Array(N);
    this.rx = new Float32Array(N);
    this.rz = new Float32Array(N);
    this.curv = new Float32Array(N);
    this.bank = new Float32Array(N);
    this.slope = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const h = Math.atan2(this.px[b] - this.px[a], this.pz[b] - this.pz[a]);
      this.hd[i] = h;
      this.tx[i] = Math.sin(h);
      this.tz[i] = Math.cos(h);
      this.rx[i] = -Math.cos(h);
      this.rz[i] = Math.sin(h);
      this.slope[i] = (this.py[b] - this.py[a]) / (2 * this.ds);
    }
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) raw[i] = wrapAngle(this.hd[(i + 1) % N] - this.hd[i]) / this.ds;
    const W = 7;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -W; k <= W; k++) s += raw[(i + k + N) % N];
      this.curv[i] = s / (2 * W + 1);
    }
    // 弯道外侧抬高（路面倾角）
    const bk = new Float32Array(N);
    for (let i = 0; i < N; i++) bk[i] = clamp(this.curv[i] * 5.5, -0.13, 0.13);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -12; k <= 12; k++) s += bk[(i + k + N) % N];
      this.bank[i] = s / 25;
    }
    // 竖直曲率（平滑后）：v²·κ > g 时车辆会腾空（跳台）
    const sy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let a = 0;
      for (let k = -3; k <= 3; k++) a += this.py[(i + k + N) % N];
      sy[i] = a / 7;
    }
    this.vcurv = new Float32Array(N);
    this.sslope = new Float32Array(N);
    const K = 4;
    for (let i = 0; i < N; i++) {
      const s0 = (sy[i] - sy[(i - K + N) % N]) / (K * this.ds);
      const s1 = (sy[(i + K) % N] - sy[i]) / (K * this.ds);
      this.vcurv[i] = (s1 - s0) / (K * this.ds);
      this.sslope[i] = (sy[(i + 1) % N] - sy[(i - 1 + N) % N]) / (2 * this.ds);
    }
    this.bridge = new Uint8Array(N);
    if (cfg.isBridge) for (let i = 0; i < N; i++) this.bridge[i] = cfg.isBridge(this.px[i], this.pz[i], this.py[i]) ? 1 : 0;

    // 空间哈希，用于地形压平 / 摆放物件避让
    this.cell = 16;
    this.grid = new Map();
    for (let i = 0; i < N; i++) {
      const k = this._key(Math.floor(this.px[i] / this.cell), Math.floor(this.pz[i] / this.cell));
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, (arr = []));
      arr.push(i);
    }
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < N; i++) {
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
    this._tmp = { i: 0, t: 0, d: 0, lat: 0, y: 0, x: 0, z: 0, tx: 0, tz: 0, rx: 0, rz: 0, bank: 0, hd: 0 };
  }

  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  nearest(x, z, maxDist = 60) {
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = maxDist * maxDist, bi = -1;
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++) {
        const arr = this.grid.get(this._key(cx + a, cz + b));
        if (!arr) continue;
        for (const i of arr) {
          const dx = this.px[i] - x, dz = this.pz[i] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) { best = d2; bi = i; }
        }
      }
    return bi < 0 ? null : { dist: Math.sqrt(best), i: bi };
  }

  forEachNear(x, z, maxDist, fn) {
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    const md2 = maxDist * maxDist;
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++) {
        const arr = this.grid.get(this._key(cx + a, cz + b));
        if (!arr) continue;
        for (const i of arr) {
          const dx = this.px[i] - x, dz = this.pz[i] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < md2) fn(i, Math.sqrt(d2));
        }
      }
  }

  sample(d, out = this._tmp) {
    const L = this.length;
    d = ((d % L) + L) % L;
    const f = d / this.ds;
    const i = Math.floor(f) % this.N;
    const j = (i + 1) % this.N;
    const t = f - Math.floor(f);
    out.i = i;
    out.t = t;
    out.d = d;
    out.x = this.px[i] + (this.px[j] - this.px[i]) * t;
    out.z = this.pz[i] + (this.pz[j] - this.pz[i]) * t;
    out.y = this.py[i] + (this.py[j] - this.py[i]) * t;
    const h = this.hd[i] + wrapAngle(this.hd[j] - this.hd[i]) * t;
    out.hd = h;
    out.tx = Math.sin(h);
    out.tz = Math.cos(h);
    out.rx = -out.tz;
    out.rz = out.tx;
    out.bank = this.bank[i] + (this.bank[j] - this.bank[i]) * t;
    out.lat = 0;
    return out;
  }

  project(x, y, z, hint, out) {
    const N = this.N;
    let bi = 0, best = Infinity;
    if (hint < 0) {
      for (let i = 0; i < N; i++) {
        const dx = this.px[i] - x, dz = this.pz[i] - z, dy = (this.py[i] - y) * 3;
        const d2 = dx * dx + dz * dz + dy * dy;
        if (d2 < best) { best = d2; bi = i; }
      }
    } else {
      for (let k = -30; k <= 30; k++) {
        const i = (hint + k + N) % N;
        const dx = this.px[i] - x, dz = this.pz[i] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; bi = i; }
      }
    }
    let i = bi;
    let j = (i + 1) % N;
    let ex = this.px[j] - this.px[i], ez = this.pz[j] - this.pz[i];
    let t = ((x - this.px[i]) * ex + (z - this.pz[i]) * ez) / (ex * ex + ez * ez);
    if (t < 0) {
      i = (bi - 1 + N) % N;
      j = bi;
      ex = this.px[j] - this.px[i];
      ez = this.pz[j] - this.pz[i];
      t = ((x - this.px[i]) * ex + (z - this.pz[i]) * ez) / (ex * ex + ez * ez);
    }
    t = clamp(t, 0, 1);
    const s = this.sample((i + t) * this.ds, out);
    s.lat = (x - s.x) * s.rx + (z - s.z) * s.rz;
    s.surfY = s.y + s.lat * Math.sin(s.bank);
    return s;
  }

  surfaceY(s, lat) { return s.y + lat * Math.sin(s.bank); }

  curvAhead(d, range) {
    const N = this.N;
    const i0 = Math.floor((((d % this.length) + this.length) % this.length) / this.ds);
    const steps = Math.max(1, Math.floor(range / this.ds));
    let m = 0;
    for (let k = 0; k < steps; k += 2) {
      const c = this.curv[(i0 + k) % N];
      if (Math.abs(c) > Math.abs(m)) m = c;
    }
    return m;
  }

  dAt(x, z) {
    const n = this.nearest(x, z, 400);
    return n ? n.i * this.ds : 0;
  }
}
