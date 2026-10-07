// 道具规则层单元测试：权重、拾取、命中判定全部在权威端，且同种子可复现
import { ItemsLogic, ITEM_CODE } from '../shared/items.js';
import { RaceWorld, placeOnGrid, CD_TICKS, HOLD_BITS, EDGE_BITS } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { PlayerCar } from '../shared/vehicle.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { encodeSnapshot, decodeSnapshot, Reader } from '../shared/proto.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}${x ? ' · ' + x : ''}`)) : (fail++, console.log(`FAIL ${n}${x ? ' · ' + x : ''}`)); };

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
// w.eventsOut 每 tick 开头会清空，逐步收集才不会漏事件
const stepEvents = (w, n = 1) => {
  const out = [];
  for (let i = 0; i < n; i++) { w.step(); out.push(...w.eventsOut); }
  return out;
};
// 按赛道里程放置车辆（保证在路面内：直接给世界坐标会把车放到路外，护栏修正会把它推飞）
const putAt = (car, d, lat = 0) => {
  const s = track.sample(d, {});
  car.x = s.x + s.rx * lat; car.z = s.z + s.rz * lat;
  car.y = s.y + lat * Math.sin(s.bank);
  car.h = car.m = s.hd; car.hint = s.i; car.d = s.d; car.lat = lat;
  car.s = 0; car.vy = 0; car.airborne = false;
  return s;
};
// 把车放到某个世界点所在的赛道位置上
const putNear = (car, x, z, yOff = 0) => {
  const p = track.project(x, 0, z, -1, {});
  putAt(car, p.d, p.lat);
  car.y = p.y + p.lat * Math.sin(p.bank) + yOff;
  return p;
};
const L = track.length;

// 1) 箱子摆位由赛道公式唯一决定（两端可以各自推导，不必传坐标）
{
  const a = new ItemsLogic(track, 3);
  const b = new ItemsLogic(track, 99);
  ok('道具箱数量与摆位确定', a.boxes.length === 20 && a.boxes.every((x, i) => x.x === b.boxes[i].x && x.z === b.boxes[i].z && x.y === b.boxes[i].y));
  const onRoad = a.boxes.every((x) => Math.abs(track.project(x.x, x.y, x.z, -1, {}).lat) < track.halfW);
  ok('道具箱都在路面内', onRoad);
}

// 2) 权重按名次：领先者偏香蕉/护盾，落后者偏导弹/磁铁
{
  const it = new ItemsLogic(track, 11);
  const tally = (rank, total, n = 4000) => {
    const c = {};
    for (let i = 0; i < n; i++) {
      const car = { items: [], carId: i };
      const got = it.giveRandom(car, rank, total);
      c[got] = (c[got] || 0) + 1;
    }
    return c;
  };
  const lead = tally(1, 6), back = tally(6, 6);
  ok('领跑更容易拿到香蕉', (lead.banana || 0) > (back.banana || 0) * 3, `领先 ${lead.banana} vs 垫底 ${back.banana || 0}`);
  ok('垫底更容易拿到导弹', (back.missile || 0) > (lead.missile || 0) * 2, `垫底 ${back.missile} vs 领先 ${lead.missile || 0}`);
  const caps = tally(3, 6);
  ok('道具槽最多两个', it.giveRandom({ items: ['nitro', 'nitro'], carId: 9 }, 3, 6) === null);
}

// 3) 同种子同序列 → 同样的发放序列（服务器可复现、可审计）
{
  const seq = (seed) => {
    const it = new ItemsLogic(track, seed);
    const out = [];
    for (let i = 0; i < 40; i++) out.push(it.giveRandom({ items: [], carId: i }, 2, 6));
    return out.join(',');
  };
  ok('同种子发放一致', seq(5) === seq(5) && seq(5) !== seq(6));
}

// 4) 拾取：车压过箱子获得道具，箱子进入 2.5 秒冷却
{
  const w = new RaceWorld({ track, seed: 21, laps: 1, itemMode: true, diff: 1 });
  const c = w.addHuman(1, '甲', 0);
  c.slot = 0;
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  const bx = w.items.boxes[10];
  putNear(c, bx.x, bx.z, -1.2);
  c.progress = 0; c.lastD = c.d;
  const before = c.items.length;
  const evs = stepEvents(w, 3);
  ok('压过箱子即获得道具', c.items.length === before + 1, `items=${c.items.join('/')}`);
  ok('箱子进入冷却', w.items.boxes[10].respawn > 0);
  const ev = evs.find((e) => e.type === 'itemGet');
  ok('拾取事件带箱子序号', !!ev && ev.box === 10, ev ? `box=${ev.box}` : '无事件');
  putAt(c, track.dAt(bx.x, bx.z) + 60); // 先离开箱子，否则一恢复就被重新踩掉
  for (let i = 0; i < Math.ceil(2.6 * 120); i++) w.step();
  ok('冷却结束后箱子恢复', w.items.boxes[10].respawn <= 0);
}

// 5) 香蕉皮：自己刚放的不算，别人压到就转圈
{
  const w = new RaceWorld({ track, seed: 5, laps: 1, itemMode: true });
  const a = w.addHuman(1, '甲', 0), b = w.addHuman(2, '乙', 1);
  a.slot = 0; b.slot = 1;
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  a.items = ['banana']; putAt(a, 200);
  w.items.use(a, w.standings);
  ok('香蕉被放下', w.items.bananas.length === 1);
  const bn = w.items.bananas[0];
  putNear(a, bn.x, bn.z);
  for (let i = 0; i < 3; i++) w.step();
  ok('放置者短时间内免疫', a.spin <= 0);
  putNear(b, bn.x, bn.z);
  const banEvs = stepEvents(w, 3);
  ok('对手压到香蕉会转圈', b.spin > 0, `spin=${b.spin.toFixed(2)} s=${b.s.toFixed(1)}`);
  ok('命中后香蕉消失', w.items.bananas.length === 0);
  ok('受击事件推给对手车辆', banEvs.some((e) => e.type === 'banana' && e.carId === b.carId));
}

// 6) 导弹：追踪前车并命中；护盾能挡一次
{
  const w = new RaceWorld({ track, seed: 77, laps: 1, itemMode: true });
  const back = w.addHuman(1, '后车', 0), lead = w.addHuman(2, '前车', 1);
  back.slot = 0; lead.slot = 1;
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  // 摆在直线段上：后车在目标后方 40 米
  putAt(back, 100); w.updateProgress(back);
  putAt(lead, 140); w.updateProgress(lead);
  w.updateStandings();
  ok('前车在名次上确实领先', lead.place === 1 && back.place === 2, `lead#${lead.place} back#${back.place}`);
  back.items = ['missile'];
  w.items.use(back, w.standings);
  // use() 在 step() 之外产生事件，而 step() 开头会清空 eventsOut，先把它们收走
  const lockEvs = [...w.eventsOut, ...stepEvents(w, 1)];
  ok('导弹锁定前车', w.items.missiles.length === 1 && w.items.missiles[0].targetId === lead.carId,
    `${w.items.missiles.length} 枚，目标 ${w.items.missiles[0]?.targetId}`);
  ok('锁定事件告知被锁定者', lockEvs.some((e) => e.type === 'missileLock' && e.who === lead.carId));
  let guard = 0;
  const allEvs = [...lockEvs];
  while (w.items.missiles.length && guard++ < 120 * 8) {
    putAt(back, 100); w.updateProgress(back);
    putAt(lead, 140); w.updateProgress(lead);
    w.updateStandings();
    allEvs.push(...stepEvents(w, 1));
  }
  ok('导弹最终命中目标', lead.spin > 0 || lead.shield > 0, `spin=${lead.spin.toFixed(2)}`);
  ok('命中后导弹移除', w.items.missiles.length === 0);
  ok('命中事件带着被击车辆 id', allEvs.some((e) => e.type === 'missiled' && e.carId === lead.carId));

  // 护盾挡一次
  const w2 = new RaceWorld({ track, seed: 78, laps: 1, itemMode: true });
  const m = w2.addHuman(1, '甲', 0), t = w2.addHuman(2, '乙', 1);
  w2.startCountdown(); w2.state = 'race'; w2.tick = CD_TICKS;
  t.shield = 7;
  w2.hitRacer(t, 'missile');
  ok('护盾吃掉一次命中', t.shield === 0 && t.spin <= 0, `shield=${t.shield} spin=${t.spin}`);
  ok('护盾命中有事件', w2.eventsOut.some((e) => e.type === 'shieldHit'));
}

// 7) 磁铁只拉近前方的车；氮气道具直接生效
{
  const w = new RaceWorld({ track, seed: 31, laps: 1, itemMode: true });
  const a = w.addHuman(1, '甲', 0), b = w.addHuman(2, '乙', 1);
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  w.updateStandings();
  a.items = ['magnet'];
  w.items.use(a, w.standings);
  ok('磁铁生效并锁定前车', a.magnet > 0, `magnet=${a.magnet} target=${a.magnetTarget ? a.magnetTarget.carId : '无'}`);
  const c = w.addHuman(3, '丙', 2);
  c.items = ['nitro'];
  c.s = 20;
  w.items.use(c, w.standings);
  ok('道具氮气立即起效', c.nitroTime > 0, `nitroTime=${c.nitroTime.toFixed(2)}`);
}

// 8) 快照里的道具状态可往返（服务器 → 客户端表现层）
{
  const w = new RaceWorld({ track, seed: 41, laps: 2, itemMode: true });
  const a = w.addHuman(1, '甲', 0);
  w.startCountdown(); w.state = 'race'; w.tick = CD_TICKS;
  a.items = ['banana', 'shield'];
  putAt(a, 100); a.s = 30;
  w.items.use(a, w.standings);
  const bts = encodeSnapshot(w, w.tick, 2);
  const r = new Reader(bts); r.u8();
  const d = decodeSnapshot(r);
  const rec = d.racers.find((x) => x.carId === a.carId);
  ok('道具槽随快照下发', rec.items[0] === 'shield' && rec.items[1] == null, `槽=${rec.items.join('/')}`);
  ok('香蕉实体随快照下发', d.items && d.items.bananas.length === 1);
  ok('箱子可见位图随快照下发', d.items && typeof d.items.mask === 'number' && d.items.mask > 0);
  ok('ITEM_CODE 与协议编码一致', ITEM_CODE.banana === 1 && ITEM_CODE.missile === 4);
}

// 9) 竞速模式不受影响（无道具段）
{
  const w = new RaceWorld({ track, seed: 1, laps: 2, itemMode: false });
  w.addHuman(1, '甲', 0);
  w.startCountdown(); w.state = 'race';
  const bts = encodeSnapshot(w, w.tick, 2);
  ok('竞速模式快照不含道具段', bts.length < 60, `${bts.length} 字节`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
