// 校验：shared/catmull.js 与 three 的 CatmullRomCurve3 是否逐位一致
import * as THREE from 'three';
import { CatmullRomClosed } from '../shared/catmull.js';
import { LAYOUTS } from '../src/layouts.js';

let worst = 0, bad = 0;
for (const id of Object.keys(LAYOUTS)) {
  const layout = LAYOUTS[id];
  const pts = layout.points.map((p) => [p[0], p[1], p[2] || 0]);
  const three = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[2], p[1])), true, 'centripetal');
  three.arcLengthDivisions = 6000;
  three.updateArcLengths();
  const mine = new CatmullRomClosed(pts.map((p) => ({ x: p[0], y: p[2], z: p[1] })), 6000);

  const lenErr = Math.abs(three.getLength() - mine.getLength());
  const N = Math.round(three.getLength() / 1.5);
  const a = three.getSpacedPoints(N).slice(0, N);
  const b = mine.getSpacedPoints(N).slice(0, N);
  let max = 0, diff = 0;
  for (let i = 0; i < N; i++) {
    const e = Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y, a[i].z - b[i].z);
    if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].z !== b[i].z) diff++;
    max = Math.max(max, e);
  }
  worst = Math.max(worst, max);
  bad += diff;
  console.log(`${id.padEnd(7)} N=${N} lenErr=${lenErr.toExponential(2)} maxPtErr=${max.toExponential(2)} nonBitwise=${diff}/${N}`);
}
console.log(worst < 1e-9 && bad === 0 ? `PASS (worst ${worst.toExponential(2)} m)` : `CHECK worst=${worst} nonBitwise=${bad}`);
