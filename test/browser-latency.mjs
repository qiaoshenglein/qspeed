// 玩家真正看到的是相机：这一份测的是"相机每帧位移/朝向突跳"，跑在真实浏览器 + 注入链路上，
// 竞速与道具两种模式都过一遍。上一轮只量了本车模型的位姿（Node 环境、只有竞速），
// 结论比用户的实际体验窄，所以才会出现"指标全绿但玩家仍然看到瞬移"。
import { chromium } from 'playwright-core';
import { startDelayProxy } from './ws-delay.mjs';
import { NetCore } from '../shared/session.js';
import { PlayerCar } from '../shared/vehicle.js';
import { stubModel, placeOnGrid } from '../shared/race.js';
import { TrackSim } from '../shared/trackCore.js';
import { LAYOUTS } from '../src/layouts.js';
import { MAPS } from '../src/maps.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT_FILE = ROOT + '.tmp/bl-port';
const ITEM = process.env.ITEM === '1';
const RTT = Number(process.env.RTT || 250);
const JITTER = Number(process.env.JITTER || 30);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 9000);
const GATE = process.env.GATE === '1';
try { await Bun.write(PORT_FILE, ''); } catch {}

const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE },
  stdout: 'ignore', stderr: 'ignore',
});
let sport = 0;
for (let i = 0; i < 100 && !sport; i++) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) sport = Number(s); else await Bun.sleep(50);
}
if (!sport) { console.log('FAIL 服务器未启动'); process.exit(1); }
const proxy = startDelayProxy(`ws://localhost:${sport}/ws`, { upMs: RTT / 2, downMs: RTT / 2, jitterMs: JITTER, seed: 99 });
const base = `http://localhost:${proxy.port}/`;

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  // 不加这三个，headless 里 rAF 会被压到 ~0.5fps（实测 9 秒只出 5 帧），逐帧采样就没有意义
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const errors = [];
async function newPage(tag) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 460 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}:` + String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${tag}c:` + m.text().slice(0, 140)); });
  const cfg = JSON.stringify({ map: 'city', mode: ITEM ? 'item' : 'speed', skin: tag === 'A' ? 0 : 1, laps: 2, diff: 1, quality: 'low', song: 0 });
  // headless 里 rAF 会被压到 ~1fps（实测 9 秒 8 帧），那样量到的是这台机器的渲染瓶颈，
  // 不是玩家设备。把 rAF 换成 60Hz 定时器：游戏逻辑/相机按真实帧率跑，软渲染画不画得完不影响位姿。
  await page.addInitScript(`(() => {
    const raf = (cb) => setTimeout(() => cb(performance.now()), 16);
    window.requestAnimationFrame = raf;
    window.webkitRequestAnimationFrame = raf;
    window.cancelAnimationFrame = (h) => clearTimeout(h);
  })();`);
  await page.addInitScript(`try { localStorage.setItem('feiche3d.v1', ${JSON.stringify(cfg)}); } catch (e) {}`);
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction(() => window.game && window.game.track, null, { timeout: 120000, polling: 300 });
  } catch (e) {
    const st = await page.evaluate(() => ({ game: typeof window.game, canvas: !!document.querySelector('canvas'), url: location.href })).catch((x) => ({ evalFail: String(x).slice(0, 80) }));
    throw new Error(`${tag} 页面没起来: ${JSON.stringify(st)} 报错: ${errors.slice(-3).join(' | ')}`);
  }
  return page;
}
const tap = async (p, id) => p.evaluate((i) => document.getElementById(i).click(), id);
const type = async (p, id, v) => p.evaluate(({ i, val }) => {
  const el = document.getElementById(i);
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { i: id, val: v });

// 在页面里挂钩：每渲染一帧记一次相机与本车/对手位姿
const INSTALL = () => {
  const g = window.game;
  window.__m = { frames: [], snaps: [], hard: [] };
  const oc = g.updateCamera.bind(g);
  g.updateCamera = (dt) => {
    oc(dt);
    const c = g.camera, P = g.player;
    const models = [];
    if (g.net) for (const [id, v] of g.net.models) if (v.model && v.model.visible) models.push([id, +v.model.position.x.toFixed(3), +v.model.position.z.toFixed(3)]);
    window.__m.frames.push({
      t: performance.now(), dt,
      cx: c.position.x, cy: c.position.y, cz: c.position.z, ry: c.rotation.y,
      px: P.x, pz: P.z, rx: P.rx ?? P.x, rz: P.rz ?? P.z, m: P.m, s: P.s, models,
    });
  };
  // 区分两种 snapCamera：开赛/换相时的正常重定位，和比赛中 hardSnap 触发的视角瞬移
  Object.defineProperty(g.net, 'hardSnap', {
    configurable: true,
    get() { return this.__hs || false; },
    set(v) { this.__hs = !!v; if (v) window.__m.hard.push(performance.now()); },
  });
  const os = g.snapCamera.bind(g);
  g.snapCamera = () => { window.__m.snaps.push(performance.now()); return os(); };
};

// 对手用的 Node 侧客户端：与游戏同一份 NetCore/PlayerCar，走同一条注入链路
const track = new TrackSim(LAYOUTS[MAPS[0].layout], { isBridge: MAPS[0].isBridge });
const steer = (car) => {
  const s = track.sample(car.d + 22, {});
  const e = ((Math.atan2(s.x - car.x, s.z - car.z) - car.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return { up: true, down: false, left: e > 0.03, right: e < -0.03, shift: Math.abs(e) > 0.4 && car.s > 20, upPressed: false, wPressed: false, nitroPressed: false };
};
function makeNodeClient(url, name, code) {
  const car = new PlayerCar(track, stubModel(), name);
  placeOnGrid(car, 0);
  const net = new NetCore({
    url, name, skin: 1, map: 'city', laps: 2, mode: ITEM ? 1 : 0, diff: 1,
    code, create: false, track, ownCar: car, itemMode: ITEM,
  });
  const timer = setInterval(() => net.step(1000 / 60, steer(net.me), net.phase >= 2 && !net.me.finished), 1000 / 60);
  net.lastErr = '';
  net.onError = (m) => { net.lastErr = m; };
  return { net, timer };
}
const waitB = async (b, code) => {
  const e = Date.now() + 30000;
  while (Date.now() < e && b.net.code !== code) await Bun.sleep(60);
  if (b.net.code !== code) throw new Error(`Node 对手没能加入 ${code}（拿到 "${b.net.code}"，err=${b.net.lastErr || '无'}）`);
};

// 任何一步失败都要把浏览器关掉：泄漏一个软渲染的 Chrome 会把后面的测量全部拖死
let mA = { frames: [], snaps: 0 };
let nodeB = null;
try {
  const A = await newPage('A');
  await tap(A, 'online');
  await type(A, 'pname', '红队阿飞');
  await type(A, 'code', 'LAT1');
  await tap(A, 'joingame');
  await A.waitForFunction(() => window.game.net && window.game.net.code, null, { timeout: 40000, polling: 200 });
  const code = await A.evaluate(() => window.game.net.code);
  const mode = await A.evaluate(() => window.game.net.mode);
  // 对手用 Node 客户端：两个软渲染页面会把这台机器压到每秒几帧，逐帧采样就没意义了。
  // 它跑的是同一份 NetCore，撞车/道具冲击照样由服务器权威结算，观测面不受影响。
  nodeB = makeNodeClient(proxy.url, '蓝队小飞', code);
  await waitB(nodeB, code);
  await tap(A, 'readybtn');
  nodeB.net.ready(true);
  await A.waitForFunction(() => window.game.net.phase >= 2, null, { timeout: 60000, polling: 200 });
  await A.evaluate(INSTALL);
  await A.keyboard.down('ArrowUp');
  await Bun.sleep(SAMPLE_MS);
  await A.keyboard.up('ArrowUp');
  mA = await A.evaluate(() => window.__m);
  const t0 = mA.frames.length ? mA.frames[0].t : 0;
  const t1 = mA.frames.length ? mA.frames[mA.frames.length - 1].t : 0;
  const inWin = (arr) => (arr || []).filter((t) => t >= t0 && t <= t1).length;
  mA.winHard = inWin(mA.hard);
  mA.winSnap = inWin(mA.snaps);
  console.log(`房间 ${code} · 模式 ${mode} · 采样 ${mA.frames.length} 帧 · 窗口内重新锚定 ${mA.winHard} 次 · 窗口内视角重定位 ${mA.winSnap} 次（全程 snapCamera ${mA.snaps.length} 次）`);
} catch (e) {
  console.log('FAIL 测量中断:', String(e.message).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  if (nodeB) { clearInterval(nodeB.timer); nodeB.net.dispose(); }
  proxy.close();
  child.kill();
}

// 位移按"这一帧真实过了多久"折算成应有位移：低帧率本来就该走更远，那不是瞬移
function judge(frames, key) {
  const pts = frames.filter((f) => Number.isFinite(f.cx));
  if (pts.length < 20) return null;
  const get = key === 'cam' ? (f) => [f.cx, f.cz] : key === 'own' ? (f) => [f.rx, f.rz] : (f) => [f.px, f.pz];
  let dist = 0, time = 0;
  const steps = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(1, pts[i].t - pts[i - 1].t);
    const d = Math.hypot(get(pts[i])[0] - get(pts[i - 1])[0], get(pts[i])[1] - get(pts[i - 1])[1]);
    steps.push({ d, dt, t: pts[i].t });
    dist += d; time += dt;
  }
  const v = dist / Math.max(1, time);
  const tele = steps.filter((s) => s.d > Math.max(2.5 * v * s.dt, 1.5)).length;
  const maxOver = Math.max(...steps.map((s) => s.d / Math.max(0.001, v * s.dt)));
  // 朝向突跳：相机 yaw 每帧应有量级由它自己的平均角速度给
  let ysum = 0;
  const yaw = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(1, pts[i].t - pts[i - 1].t);
    let d = pts[i].ry - pts[i - 1].ry;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    yaw.push({ r: Math.abs(d) / dt, dt });
    ysum += Math.abs(d);
  }
  const wr = ysum / Math.max(1, time);
  const whip = yaw.filter((y) => y.r > Math.max(4 * wr, 0.02 / 16)).length;
  const maxSpin = Math.max(...yaw.map((y) => y.r * y.dt));
  return {
    frames: pts.length, fps: +(pts.length / (time / 1000)).toFixed(1), speed: +(v * 1000).toFixed(1),
    tele, maxOver: +maxOver.toFixed(2), whip, maxSpin: +(maxSpin * 57.3).toFixed(1),
  };
}
function oppTele(frames) {
  const byId = new Map();
  for (const f of frames) for (const [id, x, z] of f.models || []) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ t: f.t, x, z });
  }
  const out = [];
  for (const [id, pts] of byId) {
    if (pts.length < 20) continue;
    let dist = 0, time = 0;
    const st = [];
    for (let i = 1; i < pts.length; i++) {
      const dt = Math.max(1, pts[i].t - pts[i - 1].t);
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      st.push({ d, dt }); dist += d; time += dt;
    }
    const v = dist / Math.max(1, time);
    out.push({
      id, tele: st.filter((s) => s.d > Math.max(2.5 * v * s.dt, 1.5)).length,
      maxOver: +Math.max(...st.map((s) => s.d / Math.max(0.001, v * s.dt))).toFixed(2),
    });
  }
  return out;
}

const label = `${ITEM ? '道具' : '竞速'} · ${RTT}ms±${JITTER}`;
const rows = [
  ['相机', judge(mA.frames, 'cam')],
  ['本车模型', judge(mA.frames, 'own')],
  ['本车物理', judge(mA.frames, 'phys')],
];
console.log(`模式 ${label}｜窗口内视角重定位 ${mA.winSnap || 0} 次 · 重新锚定 ${mA.winHard || 0} 次`);
for (const [name, r] of rows) {
  console.log(`  ${name.padEnd(9)} ${r ? `帧 ${r.frames}(${r.fps}fps) 均速 ${r.speed}m/s · 瞬移 ${r.tele} 次 · 峰值 ${r.maxOver}× · 朝向突跳 ${r.whip} 次(峰 ${r.maxSpin}°)` : '样本不足'}`);
}
const opp = oppTele(mA.frames);
console.log(`  对手车模  ${opp.map((o) => `#${o.id} 瞬移 ${o.tele} 次/峰 ${o.maxOver}×`).join(' · ') || '无'}`);

let fail = 0;
if (GATE) {
  const bad = [];
  for (const [name, r] of rows) if (r && (r.tele > 0 || r.whip > 0)) bad.push(`${name} 瞬移 ${r.tele}/朝向突跳 ${r.whip}`);
  for (const o of opp) if (o.tele > 0) bad.push(`对手#${o.id} 瞬移 ${o.tele}`);
  if ((mA.winSnap || 0) > 0) bad.push(`比赛中视角重定位 ${mA.winSnap} 次`);
  if (bad.length) { fail = 1; console.log(`FAIL ${label} 玩家可见跳变：${bad.join(' · ')}`); }
  else console.log(`PASS ${label} 相机面无可感知跳变`);
}
if (errors.length) console.log('页面报错:', errors.slice(0, 3).join(' | '));
console.log(`\n结果：${fail ? 0 : 1} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
