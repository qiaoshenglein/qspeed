// 新地图目视验收：低画质起服、进图、跑两帧、截图（这台机器软件 WebGL 很慢，只截不测）
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT_FILE = ROOT + '.tmp/maps-port';
try { await Bun.write(PORT_FILE, ''); } catch {}
const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE }, stdout: 'ignore', stderr: 'ignore',
});
let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) port = Number(s); else await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--mute-audio', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const MAPS = (process.env.ONLY || 'sunset,neon').split(',');
for (let k = 0; k < MAPS.length; k++) {
  const id = MAPS[k];
  // 每个地图独立 context：init script 会累加，复用同一页面会串设置
  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push('console:' + m.text().slice(0, 160)); });
  await page.addInitScript(`try { localStorage.setItem('feiche3d.v1', ${JSON.stringify(JSON.stringify({ map: id, mode: 'speed', skin: 0, laps: 2, diff: 1, quality: 'low', song: 0 }))}); } catch (e) {}`);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.game && window.game.track, null, { timeout: 90000, polling: 300 });
  // 直接进比赛（开局相机跟着车），再强制跑几步物理让场景里有车与动态元素
  await page.evaluate(() => { window.game.startRace(); });
  await page.waitForFunction(() => window.game.state === 'countdown' || window.game.state === 'race', null, { timeout: 30000, polling: 300 });
  await page.evaluate(() => {
    const g = window.game;
    for (let i = 0; i < 260; i++) g.step(1 / 60, { up: true, down: false, left: false, right: false, shift: false, upPressed: false, wPressed: false, nitroPressed: false });
    g.cdT = 3.1; // 跳过倒计时
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${ROOT}.tmp/map-${id}.png`, timeout: 60000 });
  // 再来一张"从车后 45 度"与远处景物的图：把车丢到隧道/大桥附近
  // 第二张图固定在"这张图的招牌景"上：日落湾的跨海桥、霓虹山道的山脊隧道口
  const at = id === 'sunset' ? [90, 348] : [-150, 168];
  await page.evaluate((a) => {
    const g = window.game, P = g.player;
    const d = (g.track.dAt(a[0], a[1]) + 30) % g.track.length;
    const s = g.track.sample(d, {});
    P.x = s.x; P.z = s.z; P.y = s.y + 0.4; P.h = s.hd; P.m = s.hd; P.s = 26;
    g.snapCamera();
    for (let i = 0; i < 24; i++) g.step(1 / 60, { up: true, down: false, left: false, right: false, shift: false, upPressed: false, wPressed: false, nitroPressed: false });
  }, at);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${ROOT}.tmp/map-${id}-2.png`, timeout: 60000 });
  const info = await page.evaluate(() => {
    const g = window.game;
    return { map: g.map && g.map.id, name: g.map && g.map.name, len: g.track && +g.track.length.toFixed(0), grip: g.track && g.track.grip, objects: g.scene ? g.scene.children.length : 0, s: +g.player.s.toFixed(1), state: g.state };
  });
  console.log(id, JSON.stringify(info), 'errors:', page.errors.slice(0, 2).join(' | ') || '无');
  await ctx.close();
}
await browser.close();
child.kill();
