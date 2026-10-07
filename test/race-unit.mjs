// RaceWorld 单元测试：圈数判定（与单机 main.js 同一套规则）、结算、双跑确定性
import { RaceWorld, DT, CD_TICKS, placeOnGrid, stubModel, HOLD_BITS } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { PlayerCar } from '../shared/vehicle.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}${x ? ' · ' + x : ''}`)) : (fail++, console.log(`FAIL ${n}${x ? ' · ' + x : ''}`)); };

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const L = track.length;

function world(seed = 7, laps = 2) {
  const w = new RaceWorld({ track, seed, laps, diff: 1 });
  return w;
}
function human(w, slot, name = '甲') {
  const c = w.addHuman(1, name, 0);
  c.slot = slot;
  return c;
}

// 1) 跑完整一圈：越过起点线一次只加一圈，且必须走过半程
{
  const w = world();
  const c = human(w, 0);
  w.startCountdown();
  w.tick = CD_TICKS; w.state = 'race';
  // 直接把车放到终点线前 6 米，全速过线
  const put = (d) => { const s = track.sample(d, {}); c.x = s.x; c.z = s.z; c.y = s.y; c.h = c.m = s.hd; c.s = 40; c.hint = s.i; c.d = s.d; c.lat = 0; };
  c.lapsDone = 0; c.owed = false; c.half = true; c.lastD = L - 6;
  put(L - 6);
  w.updateProgress(c);
  ok('过线前不误计圈', c.lapsDone === 0, `laps=${c.lapsDone}`);
  put(4);
  c.lastD = L - 2;
  w.updateProgress(c);
  ok('过起点线计一圈', c.lapsDone === 1, `laps=${c.lapsDone}`);
  const before = c.lapsDone;
  put(6);
  w.updateProgress(c);
  ok('同一圈不会重复计数', c.lapsDone === before, `laps=${c.lapsDone}`);
}

// 2) 倒退回越过线：圈数回退
{
  const w = world();
  const c = human(w, 0);
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  c.lapsDone = 1; c.owed = false; c.half = false; c.lastD = 3;
  const s1 = track.sample(L - 3, {});
  c.x = s1.x; c.z = s1.z; c.d = s1.d; c.hint = s1.i;
  w.updateProgress(c);
  ok('倒车过线回退圈数', c.lapsDone === 0 && c.owed, `laps=${c.lapsDone} owed=${c.owed}`);
}

// 3) 抄近路（没过半程就过线）不算完成一圈
{
  const w = world();
  const c = human(w, 0);
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  c.lapsDone = 0; c.owed = false; c.half = false; c.lastD = L - 3;
  const s = track.sample(4, {});
  c.x = s.x; c.z = s.z; c.d = s.d; c.hint = s.i;
  w.updateProgress(c);
  ok('未过半程时过线不计圈', c.lapsDone === 0, `laps=${c.lapsDone}`);
}

// 4) 完赛与结算：跑满圈数标记 finished，10 秒后 settle
{
  const w = world(11, 1);
  const a = human(w, 0, '甲'), b = human(w, 1, '乙');
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  a.lapsDone = 0; a.half = true; a.owed = false; a.lastD = L - 3;
  const s = track.sample(4, {});
  a.x = s.x; a.z = s.z; a.d = s.d; a.hint = s.i;
  w.updateProgress(a);
  ok('跑满圈数标记完赛', a.finished && a.lapsDone >= w.laps, `lap=${a.lapsDone}/${w.laps}`);
  ok('首个完赛者被记录', w.firstFinish >= 0);
  w.tick = CD_TICKS + Math.round(11 * 120);
  w.updateStandings();
  w.settle();
  ok('超时后结算', w.state === 'result');
  ok('完赛者优先排名', w.standings[0] === a, `${w.standings.map((c) => c.name).join(',')}`);
  ok('未完赛者名次在其后', b.place === 2);
}

// 5) 起步喷窗口：倒计时最后 0.28 秒内按 ↑ 才有效
{
  const w = world(3, 2);
  const c = human(w, 0);
  w.startCountdown();
  w.queueInput(c, 300, HOLD_BITS.up, 1); // 倒计时 2.5s 时按下（过早）
  w.tick = CD_TICKS; w.step();
  ok('过早起步不算', c.startBoost <= 0, `startBoost=${c.startBoost}`);
  const w2 = world(3, 2);
  const c2 = human(w2, 0);
  w2.startCountdown();
  w2.tick = 330; // 2.75s，处于窗口内
  w2.queueInput(c2, 331, HOLD_BITS.up, 1);
  for (let i = 0; i < 32; i++) w2.step();
  ok('窗口内起步获得起步喷', c2.startBoost > 0 || c2.s > 12, `s=${c2.s.toFixed(1)} boost=${c2.startBoost.toFixed(2)}`);
}

// 6) 同输入必同结果：两端物理一致性（预测成立的前提）
{
  const drive = (w, c, n) => {
    const seq = [];
    for (let i = 0; i < n; i++) {
      const ahead = track.sample(c.d + 22, {});
      const e = Math.atan2(ahead.x - c.x, ahead.z - c.z) - c.h;
      let bits = HOLD_BITS.up;
      if (e > 0.05) bits |= HOLD_BITS.left; else if (e < -0.05) bits |= HOLD_BITS.right;
      if (Math.abs(e) > 0.5 && c.s > 20) bits |= HOLD_BITS.shift;
      const edge = i === 400 ? 2 : 0; // 第 400 tick 按一次 W 小喷
      seq.push([bits, edge]);
      c.update(DT, { up: !!(bits & 1), down: false, left: !!(bits & 4), right: !!(bits & 8), shift: !!(bits & 16), upPressed: edge === 1, wPressed: edge === 2, nitroPressed: !!(edge & 4) }, true, false);
    }
    return c;
  };
  const mk = () => { const c = new PlayerCar(track, stubModel(), 'x'); placeOnGrid(c, 2); return c; };
  const a = drive(new RaceWorld({ track, seed: 5 }), mk(), 1500);
  const b = drive(new RaceWorld({ track, seed: 5 }), mk(), 1500);
  const same = a.x === b.x && a.z === b.z && a.s === b.s && a.h === b.h && a.m === b.m && a.gauge === b.gauge && a.nitroCount === b.nitroCount;
  ok('1500 tick 双跑逐位一致', same, `(${a.x.toFixed(6)},${a.z.toFixed(6)}) vs (${b.x.toFixed(6)},${b.z.toFixed(6)})`);
  ok('车真的在动', Math.hypot(a.x, a.z) > 1 && a.s > 10, `s=${a.s.toFixed(1)}`);
  ok('状态无 NaN', [a.x, a.z, a.y, a.h, a.m, a.s, a.gauge].every(Number.isFinite));
}

// 7) 漂移集气：权威端能攒出氮气（否则联机里无法双喷）
{
  const w = world(9, 2);
  const c = human(w, 0);
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  c.s = 40;
  for (let i = 0; i < 260; i++) {
    c.update(DT, { up: true, down: false, left: true, right: false, shift: true, upPressed: false, wPressed: false, nitroPressed: false }, true, false);
  }
  ok('漂移可以集气', c.nitroCount >= 1 || c.gauge > 0.2, `nitro=${c.nitroCount} gauge=${c.gauge.toFixed(2)}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
