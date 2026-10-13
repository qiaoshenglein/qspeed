// 对账偏移的合并与衰减规则：用一份确定的"持续同向滞后"直接打 setVisual，不碰网络、不看时钟。
//
// 场景是实测稳态：转弯时本端预测领先权威约 0.9m（本机零丢包链路的 p95），每 48ms 一份快照
// 都会重新量出同一笔滞后。
// 关键是分清两件事：
//   · 偏移 = 本端预测与权威之间的距离。渲染位姿 = 权威 + 偏移，所以偏移等于滞后量时，
//     玩家看到的正是他自己那台车应该在的位置，完全无感。
//   · 偏移 ≠ 滞后量的那部分才是"看得见的错位"：车被画在了玩家以为的位置之外。
// 所以这里量的不是偏移多大，而是"渲染位姿偏离本端预测多少"、以及它每秒动多少。
import { NetCore } from '../shared/session.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const DT = 0.016;
const FRAMES = 600;   // 9.6s

// 三种规则：现行（同向不叠加 + 线性衰减）、只把合并换回累加、改造前（整份累加 + 每帧 x*=t 的乘性衰减）
const cases = [
  ['改造前：累加 + 乘性衰减', 'old'],
  ['只改合并方式：累加 + 线性衰减', 'sum'],
  ['现行：同向不叠加 + 限速滑行', 'max'],
];

function run(rule) {
  const car = new PlayerCar(track, stubModel(), 'A');
  const net = new NetCore({ openTransport: () => ({ send() {}, close() {} }) });
  net.me = car;
  net.visual = { x: 0, z: 0, h: 0, t: 0, dur: 0.15 };
  net.dispose = () => {};
  if (rule === 'old') {
    // 复刻改造前的两条规则：新偏移整份接在旧偏移上，然后每帧乘以剩余比例
    net.decayVisual = function (dtS) {
      const v = this.visual;
      if (v.t <= 0) return;
      v.t = Math.max(0, v.t - dtS / (v.dur || 0.15));
      v.x *= v.t; v.z *= v.t; v.h *= v.t;
    };
    net.setVisual = function (dx, dz, dh) {
      const v = this.visual;
      if (v.t > 0) { dx += v.x; dz += v.z; dh += v.h; }
      const d = Math.hypot(dx, dz), ad = Math.abs(dh);
      if (d < 0.05 && ad < 0.015) return;
      if (d > 20) { this.visual = { x: 0, z: 0, h: 0, t: 0, dur: 0.15 }; this.hardSnap = true; return; }
      this.visual = { x: dx, z: dz, h: dh, t: 1, dur: Math.max(0.12, Math.min(0.9, Math.max(d / 9, ad / 3))) };
    };
  } else {
    net.visualMerge = rule;
  }

  let peakErr = 0, worstSpeed = 0, peakOff = 0, cuts = 0;
  let prev = null;
  let lead = { x: 0, z: 0 }; // 最近一次量到的滞后：两份快照之间它不变
  for (let i = 0; i < FRAMES; i++) {
    const a = i / 120; // 滞后方向随转弯缓慢转动
    if (i % 3 === 0) { // 每 3 帧 = 48ms，一份快照
      const wob = 0.9 * (0.95 + 0.05 * Math.sin(i / 40));
      lead = { x: Math.cos(a) * wob, z: Math.sin(a) * wob };
      // 权威把车拽回到预测身后 lead 这么远，setVisual 收到的就是这截差距
      car.x -= lead.x; car.z -= lead.z;
      net.setVisual(lead.x, lead.z, 0.05);
    }
    net.decayVisual(DT);
    const v = net.visual;
    const off = v.t > 0 ? { x: v.x, z: v.z } : { x: 0, z: 0 };
    if (i < 12) { prev = off; continue; } // 头几帧是起步建立偏移，不算稳态
    peakOff = Math.max(peakOff, Math.hypot(off.x, off.z));
    // 看得见的是"渲染位姿偏离本端预测"：预测位置 = 权威 + 当次滞后
    const err = Math.hypot(off.x - lead.x, off.z - lead.z);
    if (err > peakErr) peakErr = err;
    if (prev) worstSpeed = Math.max(worstSpeed, Math.hypot(off.x - prev.x, off.z - prev.z) / DT);
    prev = off;
    if (net.hardSnap) { cuts++; net.hardSnap = false; }
  }
  return { peakErr, worstSpeed, peakOff, cuts };
}

console.log(`持续 9.6s 的同向 0.9m 预测领先（200 份快照，每 48ms 一份）：`);
const res = [];
for (const [label, rule] of cases) {
  const r = run(rule);
  res.push([label, r]);
  console.log(`  ${label.padEnd(24)} 渲染偏离本端预测 峰值 ${r.peakErr.toFixed(2)}m · 错位最大速度 ${r.worstSpeed.toFixed(1)}m/s · 偏移本身峰值 ${r.peakOff.toFixed(2)}m · 硬切 ${r.cuts} 次`);
}
const bad = res.filter(([, r]) => r.peakErr > 2).map(([l]) => l);
console.log(bad.length ? `✗ 这些规则会把车画在玩家以为的位置之外（错位超过 2m）：${bad.join('、')}` : '✓ 没有规则让渲染位姿偏离本端预测超过 2m');
const cur = res[2][1];
console.log(cur.peakErr <= 2 && cur.worstSpeed <= 10 ? '✓ 现行规则：错位与错位速度都在可感知门限内' : '✗ 现行规则仍未达标');
process.exit(cur.peakErr > 2 || cur.worstSpeed > 10 ? 1 : 0);
