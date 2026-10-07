// 纯 JS 的 centripetal Catmull-Rom 闭合曲线 + 弧长重参数化。
// 与 three 的 CatmullRomCurve3/Curve 逐步等价（同样的运算顺序），
// 这样浏览器端与 Node 端算出的赛道采样点逐位一致，不存在两端几何分叉。

function CubicPoly() {
  let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
  const init = (x0, x1, t0, t1) => {
    c0 = x0;
    c1 = t0;
    c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1;
    c3 = 2 * x0 - 2 * x1 + t0 + t1;
  };
  return {
    initNonuniformCatmullRom(x0, x1, x2, x3, dt0, dt1, dt2) {
      let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
      let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
      t1 *= dt1;
      t2 *= dt1;
      init(x1, x2, t1, t2);
    },
    calc(s) {
      const s2 = s * s;
      return c0 + c1 * s + c2 * s2 + c3 * (s2 * s);
    },
  };
}

const px = CubicPoly();
const py = CubicPoly();
const pz = CubicPoly();

export class CatmullRomClosed {
  // points: [{x,y,z}]
  constructor(points, arcLengthDivisions = 6000) {
    this.points = points;
    this.arcLengthDivisions = arcLengthDivisions;
    this.cacheArcLengths = null;
    this.needsUpdate = true;
  }

  getPoint(t, out = {}) {
    const points = this.points;
    const l = points.length;
    const p = l * t;
    let intPoint = Math.floor(p);
    const weight = p - intPoint;
    if (intPoint > 0) intPoint += 0;
    else intPoint += (Math.floor(Math.abs(intPoint) / l) + 1) * l;

    const p0 = points[(intPoint - 1 + l) % l];
    const p1 = points[intPoint % l];
    const p2 = points[(intPoint + 1) % l];
    const p3 = points[(intPoint + 2) % l];

    const pow = 0.25; // centripetal: (d²)^0.25
    const dsq = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z);
    let dt0 = Math.pow(dsq(p0, p1), pow);
    let dt1 = Math.pow(dsq(p1, p2), pow);
    let dt2 = Math.pow(dsq(p2, p3), pow);
    if (dt1 < 1e-4) dt1 = 1.0;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;

    px.initNonuniformCatmullRom(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2);
    py.initNonuniformCatmullRom(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2);
    pz.initNonuniformCatmullRom(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2);
    out.x = px.calc(weight);
    out.y = py.calc(weight);
    out.z = pz.calc(weight);
    return out;
  }

  getLengths() {
    if (this.cacheArcLengths && this.cacheArcLengths.length === this.arcLengthDivisions + 1 && !this.needsUpdate) {
      return this.cacheArcLengths;
    }
    this.needsUpdate = false;
    const divisions = this.arcLengthDivisions;
    const cache = new Float64Array(divisions + 1);
    let last = this.getPoint(0, { x: 0, y: 0, z: 0 });
    const cur = { x: 0, y: 0, z: 0 };
    let sum = 0;
    for (let p = 1; p <= divisions; p++) {
      this.getPoint(p / divisions, cur);
      const dx = cur.x - last.x, dy = cur.y - last.y, dz = cur.z - last.z;
      sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
      cache[p] = sum;
      last.x = cur.x; last.y = cur.y; last.z = cur.z;
    }
    this.cacheArcLengths = cache;
    return cache;
  }

  getLength() {
    const len = this.getLengths();
    return len[len.length - 1];
  }

  getUtoTmapping(u) {
    const arcLengths = this.getLengths();
    const il = arcLengths.length;
    const targetArcLength = u * arcLengths[il - 1];
    let low = 0, high = il - 1, i = 0, comparison;
    while (low <= high) {
      i = Math.floor(low + (high - low) / 2);
      comparison = arcLengths[i] - targetArcLength;
      if (comparison < 0) low = i + 1;
      else if (comparison > 0) high = i - 1;
      else { high = i; break; }
    }
    i = high;
    if (arcLengths[i] === targetArcLength) return i / (il - 1);
    const lengthBefore = arcLengths[i];
    const lengthAfter = arcLengths[i + 1];
    const segmentFraction = (targetArcLength - lengthBefore) / (lengthAfter - lengthBefore);
    return (i + segmentFraction) / (il - 1);
  }

  getPointAt(u, out) {
    return this.getPoint(this.getUtoTmapping(u), out);
  }

  // 返回 N+1 个点（调用方按 three 的用法取前 N 个）
  getSpacedPoints(divisions) {
    const pts = [];
    const cur = { x: 0, y: 0, z: 0 };
    for (let d = 0; d <= divisions; d++) {
      this.getPointAt(d / divisions, cur);
      pts.push({ x: cur.x, y: cur.y, z: cur.z });
    }
    return pts;
  }
}
