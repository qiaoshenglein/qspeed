// 单机回归：物理层搬到 shared/ 之后，确认单机模式仍然正常（选图→开始→加速→漂移集气→HUD）
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT_FILE = ROOT + '.tmp/net-port-smoke';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}${x ? ' · ' + x : ''}`)) : (fail++, console.log(`FAIL ${n}${x ? ' · ' + x : ''}`)); };

try { await Bun.write(PORT_FILE, ''); } catch {}
const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE }, stdout: 'ignore', stderr: 'ignore',
});
const t0 = Date.now();
let port = 0;
while (Date.now() - t0 < 8000) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) { port = Number(s); break; }
  await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }
const h = await (await fetch(`http://localhost:${port}/healthz`)).json();
if (h.build !== 'qq-speed-net-v1') { console.log('FAIL 端口被旧进程占用', h); process.exit(1); }

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 400, height: 260 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await page.addInitScript(() => {
  localStorage.setItem('feiche3d.v1', JSON.stringify({ map: (location.hash === '#item' ? 'city' : 'city'), mode: 'speed', skin: 2, laps: 2, diff: 1, quality: 'low', song: 0 }));
});
await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.game && window.game.track && window.game.racers.length === 6, null, { timeout: 90000, polling: 300 });
ok('单机大厅与演示车正常', true, `${await page.evaluate(() => window.game.racers.length)} 台演示车`);

await page.waitForFunction(() => !window.game.loading, null, { timeout: 60000, polling: 250 });
const started = await page.evaluate(() => {
  const g = window.game;
  if (g.state === 'menu') g.startRace();
  return g.state;
});
ok('点击开始后进入倒计时', started === 'countdown' || started === 'race', `state=${started}`);
// 这台机器软件 WebGL 只有 ~1fps，靠墙钟等倒计时不可靠：
// 直接按固定步长驱动游戏自身的 step()（同一条单机代码路径）
const drive = (steps, inp) => page.evaluate(({ steps, inp }) => {
  const g = window.game;
  const mk = (o) => Object.assign({ up: false, down: false, left: false, right: false, shift: false, upPressed: false, wPressed: false, nitroPressed: false, swapPressed: false, resetPressed: false }, o);
  for (let i = 0; i < steps; i++) g.step(1 / 60, mk(inp));
  return { state: g.state, s: g.player.s, kmh: Math.round(g.player.speedKmh), gauge: g.player.gauge, nitro: g.player.nitroCount, drifting: g.player.drifting, x: g.player.x, z: g.player.z, racers: g.racers.length, lap: g.player.lapsDone };
}, { steps, inp });

const afterCd = await drive(240, { up: false });
ok('倒计时走完进入比赛', afterCd.state === 'race', `state=${afterCd.state}`);
const run = await drive(300, { up: true });
ok('玩家车加速正常', run.s > 25, `${run.kmh} km/h`);
ok('AI 对手仍在跑', run.racers === 6, `${run.racers} 台`);
const drift = await drive(240, { up: true, left: true, shift: true });
ok('漂移仍能集气', drift.gauge > 0.05 || drift.nitro > 0, `集气 ${drift.gauge.toFixed(2)} 氮气 ${drift.nitro}`);
const hud = await page.evaluate(() => document.getElementById('hud').innerText.replace(/\s+/g, ' ').slice(0, 60));
ok('HUD 正常显示', /\d/.test(hud), `"${hud}"`);
ok('单机无脚本错误', errs.length === 0, errs.slice(0, 2).join(' | '));

// 道具模式（单机）：ItemSystem 已重构为 shared 规则层 + 表现层，必须回归
const page2 = await ctx.newPage();
const errs2 = [];
page2.on('pageerror', (e) => errs2.push(String(e.message).slice(0, 160)));
await page2.addInitScript(() => {
  localStorage.setItem('feiche3d.v1', JSON.stringify({ map: 'city', mode: 'item', skin: 1, laps: 2, diff: 1, quality: 'low', song: 0 }));
});
await page2.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page2.waitForFunction(() => window.game && window.game.track && window.game.racers.length === 6, null, { timeout: 90000, polling: 300 });
await page2.waitForFunction(() => !window.game.loading, null, { timeout: 60000, polling: 250 });
const itemState = await page2.evaluate(() => {
  const g = window.game;
  g.startRace();
  const mk = (o) => Object.assign({ up: false, down: false, left: false, right: false, shift: false, upPressed: false, wPressed: false, nitroPressed: false, swapPressed: false, resetPressed: false }, o);
  const step = (n, inp) => { for (let i = 0; i < n; i++) g.step(1 / 60, mk(inp)); };
  const P = g.player;
  step(220, { up: true }); // 先走完 3 秒倒计时，道具系统只在比赛中演算
  // 1) 自然拾取：把车放到某个道具箱所在的赛道位置上
  const box = g.items.logic.boxes[7];
  const pr = g.track.project(box.x, box.y, box.z, -1, {});
  P.x = box.x; P.z = box.z; P.y = box.y - 1.2; P.h = P.m = pr.hd; P.hint = pr.i; P.d = pr.d; P.lat = pr.lat; P.s = 20;
  step(5, { up: true });
  const picked = (P.items || []).length;
  // 2) 使用香蕉：槽位应被消耗，地上出现实体网格
  P.items = ['banana']; P.h = P.m = pr.hd;
  step(2, { up: true });
  step(1, { up: true, nitroPressed: true });
  const afterBanana = { slots: P.items.length, bananaMeshes: g.items.meshes.bananas.size };
  // 3) 使用导弹：出现导弹网格并朝前车飞
  P.items = ['missile'];
  step(1, { up: true, nitroPressed: true });
  const afterMissile = { slots: P.items.length, missileMeshes: g.items.meshes.missiles.size };
  step(90, { up: true });
  return {
    state: g.state, itemMode: g.itemMode, hasItems: !!g.items,
    boxes: g.items.meshes.boxMeshes.length, visibleBoxes: g.items.meshes.boxMeshes.filter((m) => m.visible).length,
    picked, afterBanana, afterMissile, spin: P.spin, kmh: Math.round(P.speedKmh), s: P.s,
    meshTotal: g.items.meshes.missiles.size + g.items.meshes.bananas.size,
  };
});
ok('道具模式开关生效', itemState.itemMode === true && itemState.hasItems, `道具箱 ${itemState.boxes} 个，可见 ${itemState.visibleBoxes}`);
ok('道具模式能跑起来', itemState.state === 'race' && itemState.s > 10, `${itemState.kmh} km/h`);
ok('压过箱子即拾取', itemState.picked >= 1, `拿到 ${itemState.picked} 个`);
ok('Ctrl 使用香蕉：槽位消耗且地上有实体', itemState.afterBanana.slots === 0 && itemState.afterBanana.bananaMeshes >= 1, `槽 ${itemState.afterBanana.slots} / 实体 ${itemState.afterBanana.bananaMeshes}`);
ok('Ctrl 使用导弹：槽位消耗且有导弹网格飞行', itemState.afterMissile.slots === 0 && itemState.afterMissile.missileMeshes >= 1, `槽 ${itemState.afterMissile.slots} / 导弹 ${itemState.afterMissile.missileMeshes}`);
ok('道具实体网格数量有界（用完即回收）', itemState.meshTotal >= 0 && itemState.meshTotal < 40, `场上 ${itemState.meshTotal} 个道具实体网格`);
ok('道具模式无脚本错误', errs2.length === 0, errs2.slice(0, 2).join(' | '));

await browser.close();
child.kill();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
