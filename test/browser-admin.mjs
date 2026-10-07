// 运维台页面目视/交互验收：真浏览器打开 /admin，验证登录、KPI、房间表、点选实况、加电脑
import { chromium } from 'playwright-core';
import { C, S, Writer, Reader } from '../shared/proto.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT_FILE = ROOT + '.tmp/adminui-port';
const KEY = 'ui-check-key';
try { await Bun.write(PORT_FILE, ''); } catch {}

const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, ADMIN_TOKEN: KEY },
  stdout: 'ignore', stderr: 'ignore',
});
let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) port = Number(s); else await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }

// 先在服务端造一个有 2 名真人 + 1 台电脑的房间，页面才有东西可看
function hello(o) {
  const w = new Writer(160);
  w.u8(C.HELLO).u8(1).str(o.name).u8(o.skin).str(o.map).u8(o.laps).u8(o.mode).u8(o.diff)
    .str(o.code || '').u8(o.create ? 1 : 0).str(o.token || '');
  return w.bytes();
}
function openCli(o) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.binaryType = 'arraybuffer';
  const c = { ws, code: '', token: '' };
  c.opened = new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (e) => {
    const r = new Reader(new Uint8Array(e.data));
    if (r.u8() !== S.WELCOME) return;
    r.u16(); c.code = r.str(); r.str(); r.u8(); r.u8(); r.u8(); r.u32(); r.u32(); r.u8(); r.u8();
    if (!r.eof) r.u32();
    c.token = r.str();
    c.got = true;
  };
  c.start = async () => { await c.opened; ws.send(hello(o)); for (let i = 0; i < 60 && !c.got; i++) await Bun.sleep(50); return c; };
  return c;
}
const c1 = await openCli({ name: '甲', skin: 1, map: 'sunset', laps: 2, mode: 0, diff: 1, create: 1 }).start();
const c2 = await openCli({ name: '乙', skin: 2, map: 'sunset', laps: 2, mode: 0, diff: 1, code: c1.code }).start();
await fetch(`http://localhost:${port}/api/admin/rooms/${c1.code}/bot?key=${KEY}`, { method: 'POST' });
console.log('已造房间', c1.code, '席位', !!c1.token, !!c2.token);

const browser = await chromium.launch({
  executablePath: CHROME, headless: true, args: ['--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console:' + m.text().slice(0, 140)); });

let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { cond ? (pass++, console.log(`PASS ${n}${extra ? ' · ' + extra : ''}`)) : (fail++, console.log(`FAIL ${n}${extra ? ' · ' + extra : ''}`)); };

await page.goto(`http://localhost:${port}/admin?key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
ok('口令换 Cookie 后落到 /admin', page.url().endsWith('/admin'), page.url());
await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length >= 5, null, { timeout: 30000, polling: 200 });
const kpi = await page.evaluate(() => [...document.querySelectorAll('#kpis .kpi')].map((k) => k.querySelector('.l').textContent + '=' + k.querySelector('.v').textContent));
ok('KPI 卡片已渲染', kpi.some((t) => t.startsWith('房间=')) && kpi.some((t) => t.startsWith('席位=')), kpi.join(' | '));

await page.waitForFunction((code) => [...document.querySelectorAll('#rooms .code')].some((e) => e.textContent === code), c1.code, { timeout: 30000, polling: 200 });
const rowTxt = await page.evaluate((code) => {
  const tr = [...document.querySelectorAll('#rooms tr')].find((r) => r.querySelector('.code')?.textContent === code);
  return tr ? tr.innerText.replace(/\s+/g, ' ') : null;
}, c1.code);
ok('房间行显示地图/人数/操作', !!rowTxt && /日落湾/.test(rowTxt) && /开赛/.test(rowTxt), rowTxt);
ok('Cookie 有效时不再索要口令', await page.evaluate(() => document.getElementById('login').classList.contains('hidden')));

// 点房间码 → 右侧每车实况
await page.evaluate((code) => { [...document.querySelectorAll('#rooms .code')].find((e) => e.textContent === code).click(); }, c1.code);
await page.waitForFunction(() => document.querySelectorAll('#cars tr').length >= 3, null, { timeout: 30000, polling: 200 });
const cars = await page.evaluate(() => [...document.querySelectorAll('#cars tr')].map((t) => t.innerText.replace(/\s+/g, ' ')));
ok('实况列出真人与电脑', cars.some((t) => /甲/.test(t)) && cars.some((t) => /电脑/.test(t)), `${cars.length} 行`);
ok('实况每行含延迟/积压/丢包字段', cars.every((t) => t.split(' ').length >= 8), cars[0]);

// 加电脑按钮
const before = cars.length;
await page.evaluate((code) => {
  const tr = [...document.querySelectorAll('#rooms tr')].find((r) => r.querySelector('.code')?.textContent === code);
  window.confirm = () => true;
  [...tr.querySelectorAll('button')].find((b) => b.textContent === '+电脑').click();
}, c1.code);
await page.waitForFunction((n) => document.querySelectorAll('#cars tr').length > n, before, { timeout: 30000, polling: 250 });
const after = await page.evaluate(() => document.querySelectorAll('#cars tr').length);
ok('加电脑按钮生效', after === before + 1, `${before} → ${after}`);
const logTxt = await page.evaluate(() => document.querySelector('#log').innerText.trim());
ok('操作记录留痕', /bot/.test(logTxt), logTxt.split('\n').pop());
await page.screenshot({ path: `${ROOT}.tmp/admin-ui.png`, timeout: 40000 });

// 未带口令时看到登录壳
const ctx2 = await browser.newContext();
const p2 = await ctx2.newPage();
await p2.goto(`http://localhost:${port}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p2.waitForFunction(() => !document.getElementById('login').classList.contains('hidden'), null, { timeout: 20000, polling: 200 });
ok('无口令时要求输入访问口令', await p2.evaluate(() => document.getElementById('login').innerText.includes('访问口令')));
await p2.evaluate(() => { document.getElementById('key').value = 'wrong'; document.getElementById('enter').click(); });
await p2.waitForFunction(() => !document.getElementById('keyerr').classList.contains('hidden'), null, { timeout: 20000, polling: 200 });
ok('错口令给出提示', true);
await p2.screenshot({ path: `${ROOT}.tmp/admin-login.png`, timeout: 40000 });
await ctx2.close();

ok('页面脚本无报错', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
c1.ws.close(); c2.ws.close();
child.kill();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
