import { startDelayProxy } from '../test/ws-delay.mjs';
const PORT_FILE = '.tmp/pp-port';
await Bun.write(PORT_FILE, '');
const child = Bun.spawn([process.execPath, 'server/index.js'], { env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE }, stdout: 'ignore', stderr: 'ignore' });
let sport = 0;
for (let i = 0; i < 60 && !sport; i++) { const s = (await Bun.file(PORT_FILE).text()).trim(); if (s) sport = +s; else await Bun.sleep(50); }
const p = startDelayProxy(`ws://localhost:${sport}/ws`, { upMs: 5, downMs: 5, jitterMs: 0, seed: 1 });
await Bun.sleep(200);
try {
  const r = await fetch(`http://localhost:${p.port}/`);
  const t = await r.text();
  console.log('status', r.status, 'len', t.length, 'hasGame', t.includes('APP_SCRIPT') ? '未替换占位符!' : 'ok', 'head', t.slice(0, 40).replace(/\n/g, ' '));
} catch (e) { console.log('代理取页面失败:', String(e).slice(0, 200)); }
try {
  const r2 = await fetch(`http://localhost:${p.port}/rooms`);
  console.log('/rooms', r2.status, (await r2.text()).slice(0, 60));
} catch (e) { console.log('/rooms 失败:', String(e).slice(0, 120)); }
p.close(); child.kill();
process.exit(0);
