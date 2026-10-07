// 赛道布局体检：自交/邻道间距/最小转弯半径/纵坡。新图先过这一关再谈美术。
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}${x ? ' · ' + x : ''}`)) : (fail++, console.log(`FAIL ${n}${x ? ' · ' + x : ''}`)); };

const STEP = 2; // 每 2 米一个检查点
const names = Object.fromEntries(MAPS.map((m) => [m.layout, m.name]));
for (const [key, layout] of Object.entries(LAYOUTS)) {
  const m = { name: names[key] || key };
  ok(`${key} 有对应地图配置`, !!names[key], MAPS.some((x) => x.layout === key) ? '' : '布局存在但没有任何地图使用它');
  const t = new TrackSim(layout, {});
  const hw = t.halfW;
  const N = Math.floor(t.length / STEP);
  const pts = [];
  for (let i = 0; i < N; i++) {
    const s = t.sample(i * STEP, {});
    pts.push({ x: s.x, z: s.z, y: s.y, hd: s.hd, d: s.d });
  }
  // 1) 邻道间距：沿赛道相距足够远的两段中心线不能靠得比两个路宽还近。
  //    高程差足够大时是立交/隧道（雪地的 8 字立交就是设计意图），不算穿插。
  let minGap = 1e9, gapAt = -1, overlap = 0;
  const far = Math.ceil((hw * 6) / STEP);
  for (let i = 0; i < N; i++) {
    for (let j = i + far; j < N; j++) {
      const along = Math.min(j - i, N - (j - i)) * STEP; // 沿中心线的最短距离（考虑闭合）
      if (along < hw * 6) continue;
      const dx = pts[i].x - pts[j].x, dz = pts[i].z - pts[j].z;
      const d = Math.hypot(dx, dz);
      if (d < minGap && Math.abs(pts[i].y - pts[j].y) > 5) minGap = d; // 只有立交式靠近才记录为"安全靠近"
      if (d < hw * 2 && Math.abs(pts[i].y - pts[j].y) < 5) { overlap++; if (gapAt < 0) gapAt = Math.round(pts[i].d); }
    }
  }
  ok(`${m.name} 无自交穿插`, overlap === 0, overlap ? `${overlap} 处同层重叠，最早 @ d=${gapAt}` : `最近同层邻道 ${(minGap === 1e9 ? 0 : minGap).toFixed(1)}m`);

  // 2) 最小转弯半径：半径过小意味着 60km/h 也过不去，属于设计缺陷而非风格
  let minR = 1e9, rAt = 0;
  for (let i = 1; i < N; i++) {
    let da = pts[i].hd - pts[i - 1].hd;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const r = STEP / Math.max(1e-6, Math.abs(da));
    if (r < minR) { minR = r; rAt = Math.round(pts[i].d); }
  }
  ok(`${m.name} 有可通行半径`, minR > 12, `最小转弯半径 ${minR.toFixed(1)}m @ d=${rAt}`);

  // 3) 纵坡：超过 ~22% 的坡会让车腾空判定失真
  let maxSlope = 0;
  for (let i = 1; i < N; i++) maxSlope = Math.max(maxSlope, Math.abs(pts[i].y - pts[i - 1].y) / STEP);
  ok(`${m.name} 纵坡合理`, maxSlope < 0.24, `最大纵坡 ${(maxSlope * 100).toFixed(1)}%`);

  // 4) 起伏连续：相邻采样高差不应突跳（控制点写错时会在这里炸）
  let maxJump = 0;
  for (let i = 1; i < N; i++) maxJump = Math.max(maxJump, Math.abs(pts[i].y - pts[i - 1].y));
  ok(`${m.name} 高程连续`, maxJump < 1.2, `最大单步高差 ${maxJump.toFixed(2)}m`);

  // 5) 圈长与弯数（给设计对照用，不作断言）
  let corners = 0, acc = 0;
  for (let i = 1; i < N; i++) {
    let da = pts[i].hd - pts[i - 1].hd;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    acc += Math.abs(da);
    if (acc > 0.5) { corners++; acc = 0; }
  }
  console.log(`     ${m.name}：一圈 ${t.length.toFixed(0)}m · 宽 ${(hw * 2).toFixed(0)}m · 弯道段 ${corners} 处 · 高差 ${(Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))).toFixed(0)}m`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
