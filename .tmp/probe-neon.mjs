import { chromium } from 'playwright-core';
const ROOT = 'D:/game/qq-speed/';
await Bun.write(ROOT + '.tmp/neon-port', '');
const child = Bun.spawn([process.execPath, 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', NET_PORT_FILE: ROOT + '.tmp/neon-port' }, stdout: 'ignore', stderr: 'ignore' });
let port = 0;
for (let i = 0; i < 100 && !port; i++) { const s = (await Bun.file(ROOT + '.tmp/neon-port').text()).trim(); if (s) port = Number(s); else await Bun.sleep(50); }
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 700, height: 400 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e.message).slice(0, 600)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.addInitScript(`try { localStorage.setItem('feiche3d.v1', ${JSON.stringify(JSON.stringify({ map: 'neon', mode: 'speed', skin: 0, laps: 2, diff: 1, quality: 'low', song: 0 }))}); } catch (e) {}`);
await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
console.log('booted:', await page.evaluate(() => !!(window.game && window.game.track)).catch(() => 'no window.game'));
console.log('state:', await page.evaluate(() => ({ state: window.game && window.game.state, map: window.game && window.game.map && window.game.map.id, loading: window.game && window.game.loading })).catch(() => '?'));
console.log(errs.slice(0, 4).join('\n---\n') || '无错误');
await browser.close(); child.kill(); process.exit(0);
