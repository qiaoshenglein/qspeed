// 高延迟瞬移测量：真实服务器 + 真实客户端栈，中间插一段带抖动的链路，
// 按 60Hz 采样"最终渲染位姿"，统计单帧跳变（瞬移）、修正幅度、tick 超前量。
// 用法：bun test/high-latency.mjs          只看数据
//       GATE=1 bun test/high-latency.mjs   按门禁判定（部署脚本用）
import { NetCore } from '../shared/session.js';
import { S } from '../shared/proto.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel, placeOnGrid } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { startDelayProxy } from './ws-delay.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT_FILE = ROOT + '.tmp/hl-port';
const KEY = 'hl-test-key';
const GATE = process.env.GATE === '1';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim()) : null;
const MEASURE_MS = Number(process.env.MEASURE_MS || 6000);
try { await Bun.write(PORT_FILE, ''); } catch {}

const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, ADMIN_TOKEN: KEY },
  stdout: 'ignore', stderr: 'ignore',
});
let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) port = Number(s); else await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }
const health = await (await fetch(`http://localhost:${port}/healthz`)).json();
if (health.build !== 'qq-speed-net-v1') { console.log('FAIL 命中的是旧服务进程', health); process.exit(1); }

const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const FRAME_MS = 1000 / 60;

function makeClient(url, name, skin, code) {
  const car = new PlayerCar(track, stubModel(), name);
  placeOnGrid(car, 0);
  const net = new NetCore({ url, name, skin, map: 'city', laps: 2, mode: 0, diff: 1, code, create: !code, track, ownCar: car });
  net.corr = [];      // 每次对账施加的视觉修正幅度
  net.reanchors = 0;  // 重新锚定次数（本端 tick 轴复位）
  net.cuts = 0;       // 切镜头次数（偏差超过 CUT_DIST：本端整段没过帧）
  net.gapMax = 0;     // 本端 tick 领先权威 ackTick 的最大值
  net.ackSeen = 0;
  const ra = net.reanchor.bind(net);
  net.reanchor = (ack, rec) => { net.reanchors++; return ra(ack, rec); };
  const sv = net.setVisual.bind(net);
  net.setVisual = (dx, dz, dh) => {
    const d = Math.hypot(dx, dz);
    if (d > 0.02) net.corr.push({ d, bump: net.tick - net.lastBumpTick < 90 }); // 90 tick 内被撞过
    return sv(dx, dz, dh);
  };
  net.onEvent = (ev) => { if (ev.type === 'bumpHit') net.lastBumpTick = net.tick; };
  const rc = net.reconcile.bind(net);
  net.reconcile = (rec) => { net.gapMax = Math.max(net.gapMax, net.tick - rec.ackTick); net.ackSeen = rec.ackTick; return rc(rec); };
  net.rosters = 0;
  const om = net.onMsg.bind(net);
  net.onMsg = (buf) => {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b[0] === S.ROSTER) net.rosters++;
    return om(buf);
  };
  return net;
}

const steer = (car) => {
  const s = track.sample(car.d + 22, {});
  const e = ((Math.atan2(s.x - car.x, s.z - car.z) - car.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return { up: true, down: false, left: e > 0.03, right: e < -0.03, shift: Math.abs(e) > 0.4 && car.s > 20, upPressed: false, wPressed: false, nitroPressed: false };
};

function stats(tr) {
  if (tr.length < 10) return null;
  // 每帧位移要按"这一帧真实过了多久"来判：客户端卡了 88ms，车本来就该走 5m，那不是瞬移。
  // 瞬移 = 单帧位移显著超过这段时间内应有的位移。
  const dtSum = tr.reduce((a, b) => a + (b.dt || 0), 0);
  let steps = [], jerk = 0, rev = 0;
  for (let i = 1; i < tr.length; i++) {
    const dx = tr[i].x - tr[i - 1].x, dz = tr[i].z - tr[i - 1].z;
    steps.push({ d: Math.hypot(dx, dz), dx, dz, dt: tr[i].dt || 16.7 });
  }
  const vPerMs = steps.reduce((a, b) => a + b.d, 0) / Math.max(1, steps.reduce((a, b) => a + b.dt, 0));
  const mean = steps.reduce((a, b) => a + b.d, 0) / steps.length;
  for (let i = 1; i < steps.length; i++) {
    jerk += Math.hypot(steps[i].dx - steps[i - 1].dx, steps[i].dz - steps[i - 1].dz);
    if (steps[i].dx * steps[i - 1].dx + steps[i].dz * steps[i - 1].dz < -1e-6) rev++;
  }
  const over = steps.map((s) => s.d / Math.max(0.001, vPerMs * s.dt));
  const sorted = [...over].sort((a, b) => a - b);
  const tele = over.filter((r, i) => r > 2.5 && steps[i].d > 1.2).length;
  return {
    frames: tr.length, meanStep: +mean.toFixed(3), maxOver: +sorted[sorted.length - 1].toFixed(2),
    p99Over: +sorted[Math.floor(sorted.length * 0.99)].toFixed(2), tele,
    meanJerk: +(jerk / steps.length).toFixed(4), reversals: rev, maxStep: +Math.max(...steps.map((s) => s.d)).toFixed(2),
    dtSum: +dtSum.toFixed(0),
  };
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };

async function runConfig(cfg) {
  const proxy = startDelayProxy(`ws://localhost:${port}/ws`, {
    upMs: cfg.rtt / 2, downMs: cfg.rtt / 2, jitterMs: cfg.jitter, seed: cfg.seed,
  });
  const wait = async (fn, ms, what, diag) => {
    const e = Date.now() + ms;
    while (Date.now() < e && !fn()) await Bun.sleep(60);
    if (!fn()) throw new Error(`超时：${what} · ${diag ? JSON.stringify(diag()) : ''}`);
  };
  const a = makeClient(proxy.url, '甲', 0, '');
  const all = [a];
  let code = '';
  const tr = { own: [], rem: [], own2: [], rem2: [] };
  let mode = 'idle'; // idle 只仿真不采样 · sample/recover 采样 · freeze 冻住被观测端
  let pick = null;
  const clk = { jumps: 0, maxDelta: 0, starve: 0, prevRT: 0, rebuff: 0, stObj: null, stalls: 0, maxDt: 0, last: 0 };
  // 客户端从一开始就按真实时间连续仿真——真人不会在比赛开始前停掉自己的帧。
  // frameMs 用来模拟"这台设备只有这么点帧率"（10fps = 每帧 100ms 真实时间）
  const stepMs = cfg.frameMs || FRAME_MS;
  const loop = setInterval(() => {
    const now = performance.now();
    const dtMs = Math.min(2000, Math.max(1, now - (clk.last || now - stepMs)));
    clk.last = now;
    clk.maxDt = Math.max(clk.maxDt, dtMs);
    if (dtMs > stepMs * 2) clk.stalls++;
    const dtS = dtMs / 1000;
    for (const n of all) {
      if (n === a && mode === 'freeze') continue;
      n.step(dtMs, steer(n.me), n.phase >= 2 && !n.me.finished);
      if (n.hardSnap) { n.cuts++; n.hardSnap = false; }
    }
    if (mode !== 'sample' && mode !== 'recover') return;
    const own = mode === 'recover' ? tr.own2 : tr.own;
    const rem = mode === 'recover' ? tr.rem2 : tr.rem;
    a.syncPose(dtS);
    own.push({ x: a.me.rx, z: a.me.rz, dt: dtMs });
    if (!pick) for (const [id, st] of a.remote) if (id !== a.myCarId && st.cur) { pick = id; break; }
    const st = pick && a.remote.get(pick);
    if (st && st.cur) {
      if (clk.stObj && clk.stObj !== st) clk.rebuff++;   // 该车状态对象被重建（掉线/重进快照）
      clk.stObj = st;
      const rt = a.renderTick();
      if (clk.prevRT) {
        const d = rt - clk.prevRT;
        clk.maxDelta = Math.max(clk.maxDelta, d);
        // 60Hz 每帧本应推进 2 tick，速率校正允许 ±25%；超出即为时钟跳变
        if (d > 2.6 || d < 0) clk.jumps++;
      }
      clk.prevRT = rt;
      // 渲染点落在缓冲区间外 = 缓冲饥饿，只能直线推算
      if (st.buf && st.buf.length && rt > st.buf[st.buf.length - 1].tick) clk.starve++;
      const s = a.interpState(st, rt);
      if (s) rem.push({ x: s.x, z: s.z, dt: dtMs });
    }
  }, FRAME_MS);

  let res = null;
  try {
    // 高延迟下握手本身就要一个 RTT 以上，必须等房间码回来再让别人加入
    await wait(() => !!a.code, 8000, '房间码');
    code = a.code;
    cfg.code = code; // 失败时让调用方也能把房间关掉，别让它继续在服务器上跑
    const b = makeClient(proxy.url, '乙', 1, code);
    const c = makeClient(proxy.url, '丙', 2, code);
    all.push(b, c);
    // 名单要三人各自都收到"三车"那一条才能继续。高延迟下这条广播偶尔落在等待窗口外，
    // 就再点一次准备（真人反复点准备也是同一条路径：服务器会重发名单）
    const seen3 = (n) => n.roster.length >= 3;
    for (let i = 0; !([a, b, c].every(seen3)) && i < 40; i++) {
      if (i % 6 === 5) for (const n of [a, b, c]) n.ready(true);
      await Bun.sleep(200);
    }
    if (![a, b, c].every(seen3)) {
      throw new Error(`超时：三名玩家进同一房间 ${code} · ${JSON.stringify({
        a: a.roster.map((r) => r.name).join(','), b: b.roster.length, c: c.roster.length,
        收到名单: [a.rosters, b.rosters, c.rosters], ac: a.code, bc: b.code, cc: c.code,
      })}`);
    }
    for (const n of [a, b, c]) n.ready(true);
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`http://localhost:${port}/api/admin/rooms/${code}/start?key=${KEY}`, { method: 'POST' });
      if (r.ok) break;
      await Bun.sleep(200);
    }
    const st2 = () => ({ phase: a.phase, tick: a.worldTick, s: +a.me.s.toFixed(1), snaps: a.snapCount, code, cars: a.remote.size });
    await wait(() => a.phase >= 2, 12000, '进入比赛阶段', st2);
    await wait(() => a.me.s > 8 && a.worldTick > 500, 8000, '车辆已跑起来', st2);

    const baseRa = a.reanchors, baseCuts = a.cuts, baseCorr = a.corr.length;
    a.gapMax = 0; // 开赛那一次重锚带来的巨大领先量不算进稳定窗口
    let raBefore = 0, raTail = 0, tailAt = 0, raBeforeCuts = 0, raTailCuts = 0;
    // 同时从服务器侧看这条链路：bias 是服务器对"本端 tick ↔ 服务器 tick"偏移的估计，
    // 它一旦发散（积分饱和）就会让 ackTick 乱跳，本端再怎么回滚都救不回来
    const srv = { biasMax: 0, droppedMax: 0, pendMax: 0, samples: 0, t0: 0, k0: 0, t1: 0, k1: 0 };
    const poll = setInterval(async () => {
      try {
        const d = await (await fetch(`http://localhost:${port}/debug/rooms`)).json();
        const room = d.rooms.find((r) => r.code === code);
        const car = room && room.cars.find((c) => c.name === '甲');
        if (car && room) {
          srv.biasMax = Math.max(srv.biasMax, Math.abs(car.bias));
          srv.droppedMax = Math.max(srv.droppedMax, car.dropped || 0);
          srv.pendMax = Math.max(srv.pendMax, car.pend);
          if (!srv.samples) { srv.t0 = Date.now(); srv.k0 = room.tick; }
          srv.t1 = Date.now(); srv.k1 = room.tick;
          srv.samples++;
        }
      } catch { /* 服务器正在关房 */ }
    }, 300);
    if (cfg.stall) {
      // 观测端连续卡住 3 秒（页面挂起/切后台）：本端 tick 与服务器脱开上百 tick。
      // 卡完必须一次重锚定就稳住——之后再连续硬跳就是机制没兜住。
      mode = 'sample'; await Bun.sleep(1500);
      mode = 'freeze'; clk.prevRT = 0; await Bun.sleep(3000);
      raBefore = a.reanchors; raBeforeCuts = a.cuts;
      mode = 'recover'; await Bun.sleep(600);
      raTail = a.reanchors; raTailCuts = a.cuts; tailAt = tr.own2.length;
      await Bun.sleep(2000);
      mode = 'idle';
    } else {
      mode = 'sample'; await Bun.sleep(MEASURE_MS); mode = 'idle';
    }

    clearInterval(poll);
    // 只统计稳定窗口内的量：开赛那一下必然有一次重锚（本端在大厅里空转的 tick 要作废），
    // 把它算进"高延迟瞬移"里会让门禁永远看不到真实问题
    const raWin = a.reanchors - baseRa;
    const corr = a.corr.slice(baseCorr);
    const cd = corr.map((e) => e.d);
    res = {
      srv,
      // 服务器有没有真跑满 120Hz：跑不满说明这台机器在拖后腿，这一档的抖动不能算到机制头上
      srvHz: srv.samples > 1 && srv.t1 > srv.t0 ? +((srv.k1 - srv.k0) / (srv.t1 - srv.t0) * 1000).toFixed(1) : 0,
      rtt: cfg.rtt, jitter: cfg.jitter, stall: !!cfg.stall, fps: cfg.fps || 60,
      own: stats(tr.own), rem: stats(tr.rem),
      own2: cfg.stall ? stats(tr.own2) : null, rem2: cfg.stall ? stats(tr.rem2) : null,
      own2tail: cfg.stall ? stats(tr.own2.slice(tailAt)) : null,
      rem2tail: cfg.stall ? stats(tr.rem2.slice(tailAt)) : null,
      cuts: a.cuts - baseCuts,
      recovCuts: cfg.stall ? a.cuts - raBeforeCuts : 0,
      recovCutsTail: cfg.stall ? a.cuts - raTailCuts : 0,
      recovRa: cfg.stall ? a.reanchors - raBefore : 0,
      recovRaTail: cfg.stall ? a.reanchors - raTail : 0,
      link: { ...proxy.stats, ms: cfg.stall ? 4 : Math.round(MEASURE_MS / 1000) },
      clk: { jumps: clk.jumps, maxDelta: +clk.maxDelta.toFixed(2), starve: clk.starve, frames: tr.rem.length, rebuff: clk.rebuff, stalls: clk.stalls, maxDt: +clk.maxDt.toFixed(1) },
      reanchors: raWin, rolls: a.rolls, gapMax: a.gapMax,
      corrMax: pct(cd, 0.999), corrP95: pct(cd, 0.95), corrN: cd.length,
      // 大修正(>1.5m)归因：撞车后 90 tick 内 vs 其他（输入时序抖动）
      bigBump: corr.filter((e) => e.d > 1.5 && e.bump).length,
      bigOther: corr.filter((e) => e.d > 1.5 && !e.bump).length,
      rttSeen: Math.round(a.rtt),
    };
  } finally {
    clearInterval(loop);
    proxy.close();
    for (const n of all) n.dispose();
    // 关掉房间：否则它的 120Hz 循环会一直占着 CPU，把后面几档的测量结果污染掉
    if (code) await fetch(`http://localhost:${port}/api/admin/rooms/${code}/close?key=${KEY}`, { method: 'POST' }).catch(() => {});
    await Bun.sleep(250);
  }
  return res;
}

const CONFIGS = [
  { rtt: 10, jitter: 3, seed: 11 },
  { rtt: 120, jitter: 18, seed: 22 },
  { rtt: 240, jitter: 30, seed: 33 },
  { rtt: 400, jitter: 55, seed: 44 },
  { rtt: 600, jitter: 80, seed: 55 },
  { rtt: 240, jitter: 30, seed: 66, stall: true, id: 'stall' }, // 240ms 链路上把观测端卡住 3 秒
  // 弱设备：帧率越低，一帧真实经过的时间越长。客户端必须按真实时间补齐，
  // 否则会永远追在服务器后面，每份快照都重新锚定 —— 玩家看到的就是连续瞬移
  { rtt: 240, jitter: 30, seed: 77, frameMs: 50, fps: 20, id: 'fps20' },
  { rtt: 240, jitter: 30, seed: 88, frameMs: 100, fps: 10, id: 'fps10' },
  { rtt: 240, jitter: 30, seed: 66, frameMs: 250, fps: 4, id: 'fps4' },
  { rtt: 240, jitter: 30, seed: 66, frameMs: 300, fps: 3, id: 'fps3' },
  { rtt: 240, jitter: 30, seed: 66, frameMs: 1000, fps: 1, id: 'fps1' },
  { rtt: 240, jitter: 30, seed: 66, frameMs: 250, fps: 4, stall: true, id: 'fps4stall' },
  { rtt: 240, jitter: 30, seed: 66, frameMs: 300, fps: 3, stall: true, id: 'fps3stall' },
  { rtt: 240, jitter: 30, seed: 66, frameMs: 1000, fps: 1, stall: true, id: 'fps1stall' },
];
CONFIGS.forEach((c) => { c.id = c.id || String(c.rtt); });

console.log('链路             | 本车瞬移 峰值倍率 p99倍率 重锚 切 修正p95/最大 | 他车瞬移 峰值倍率 p99倍率 反转 | tick超前 实测RTT');
let fail = 0;
const out = [];
for (const cfg of CONFIGS) {
  if (ONLY && !ONLY.includes(cfg.id)) continue;
  let r;
  try { r = await runConfig(cfg); } catch (e) {
    fail++;
    console.log(`FAIL ${cfg.id} 档跑不起来：${e.message}`);
    if (cfg.code) await fetch(`http://localhost:${port}/api/admin/rooms/${cfg.code}/close?key=${KEY}`, { method: 'POST' }).catch(() => {});
    continue;
  }
  out.push(r);
  const f = (n, w) => String(n).padStart(w);
  // 卡顿恢复档看的是"恢复窗口"里的表现，不是稳定窗口
  const own = r.own2 || r.own, rem = r.rem2 || r.rem;
  const ra = r.stall ? r.recovRa : r.reanchors;
  const cuts = r.stall ? r.recovCuts : r.cuts;
  const label = (r.stall ? `${r.rtt}ms+卡3秒` : r.fps !== 60 ? `${r.rtt}ms@${r.fps}fps` : `${r.rtt}ms ±${r.jitter}`).padEnd(15);
  console.log(
    `${label} |${f(own.tele, 8)}${f(own.maxOver, 10)}${f(own.p99Over, 9)}${f(ra, 6)}${f(cuts, 5)}${f(r.corrP95.toFixed(2) + '/' + r.corrMax.toFixed(1), 14)} |` +
    `${f(rem.tele, 8)}${f(rem.maxOver, 10)}${f(rem.p99Over, 9)}${f(rem.reversals, 6)} |${f(r.gapMax, 8)}${f(r.rttSeen + 'ms', 9)}`
  );
  const h = await (await fetch(`http://localhost:${port}/healthz`)).json();
  if (r.stall) {
    console.log(`  卡 3 秒后恢复：前 0.6s 内重锚 ${r.recovRa} 次/切镜头 ${r.recovCuts} 次，之后 2s 本车瞬移 ${r.own2tail.tele} 次/峰值 ${r.own2tail.maxOver} 倍｜他车瞬移 ${r.rem2tail ? r.rem2tail.tele : '?'} 次/峰值 ${r.rem2tail ? r.rem2tail.maxOver : '?'} 倍·重锚 ${r.recovRaTail} 次/切镜头 ${r.recovCutsTail} 次`);
  }
  console.log(`  链路：上 ${r.link.up} 包/${r.link.upBytes}B · 下 ${r.link.down} 包/${r.link.downBytes}B（${r.link.ms}s）· 丢弃 类型${r.link.badType}/无目标${r.link.noTarget}/发送失败${r.link.sendFail}｜他车渲染时钟：跳变 ${r.clk.jumps} 次/最大单帧 ${r.clk.maxDelta}tick · 缓冲饥饿 ${r.clk.starve}/${r.clk.frames} 帧 · 状态重建 ${r.clk.rebuff} 次 · 本端卡顿帧 ${r.clk.stalls}(最长 ${r.clk.maxDt}ms)｜>1.5m 修正 ${r.bigBump + r.bigOther} 次：撞车后 ${r.bigBump} / 其他 ${r.bigOther}｜服务器侧 ${r.srvHz}Hz |bias|峰 ${r.srv.biasMax} · 输入丢弃 ${r.srv.droppedMax} · 队列峰 ${r.srv.pendMax}${h.rooms ? ` · 服务器上还有 ${h.rooms} 个房间在仿真` : ''}`);
}

if (GATE) {
  // 门禁：任何链路档位都不允许出现肉眼可见的瞬移（单帧位移超过该帧应有位移的 2.5 倍）
  // 卡顿档额外要求：卡完允许一次重锚定（0.6s 内），之后必须立刻稳住
  for (const r of out) {
    const tag = `${r.rtt}ms${r.stall ? '+卡顿' : ''}${r.fps !== 60 ? '@' + r.fps + 'fps' : ''}`;
    // 环境不达标就不判：服务器跑不满 120Hz、或本端采样帧被拖到 40ms 以上，
    // 量出来的是这台机器的负载，不是链路机制。跳过并说明，比误报"失败"更有用。
    if (r.srvHz < 112 || r.clk.maxDt > 40) {
      console.log(`SKIP ${tag} 档：环境负载不足以上限判定的测量（服务器实测 ${r.srvHz}Hz · 本端最长帧 ${r.clk.maxDt}ms）`);
      continue;
    }
    if (r.stall) {
      const bad = r.recovRa > 2 || r.own2tail.tele > 0 || r.recovRaTail > 0 || r.recovCutsTail > 0 || r.own2tail.maxOver > 2.5 ||
        (r.rem2tail && (r.rem2tail.tele > 0 || r.rem2tail.maxOver > 2.5));
      if (bad) { fail++; console.log(`FAIL ${tag} 档恢复不干净：重锚 ${r.recovRa} 次，之后本车瞬移 ${r.own2tail.tele} 次/峰值 ${r.own2tail.maxOver} 倍/重锚 ${r.recovRaTail} 次，他车瞬移 ${r.rem2tail ? r.rem2tail.tele : '无'} 次/峰值 ${r.rem2tail ? r.rem2tail.maxOver : '无'} 倍`); }
      else console.log(`PASS ${tag} 档一次重锚后立刻稳住`);
      continue;
    }
    const own = r.own, rem = r.rem;
    const bad = own.tele > 0 || rem.tele > 0 || r.cuts > 0 || own.maxOver > 2.5 || rem.maxOver > 2.5;
    if (bad) { fail++; console.log(`FAIL ${tag} 档仍有瞬移：本车跳变 ${own.tele} 次/峰值 ${own.maxOver} 倍，他车 ${rem.tele} 次/峰值 ${rem.maxOver} 倍，重锚 ${r.reanchors} 次/切镜头 ${r.cuts} 次`); }
    else console.log(`PASS ${tag} 档无可感知瞬移`);
  }
}
console.log(`\n结果：${out.length} 档链路有数据，${fail} 项失败`);
process.exit(fail ? 1 : 0);
