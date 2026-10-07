// 后台运维台（A 层）：口令鉴权 + 实况只读 + 干预操作，全部走真 HTTP/WS
import { C, S, PHASE, Writer, Reader } from '../shared/proto.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT_FILE = ROOT + '.tmp/admin-port';
const TOKEN_FILE = ROOT + '.tmp/admin-token-test';
const GHOST = ROOT + '.data/ghost-check'; // 不该被写：确认 env 指定的口令文件生效
try { await Bun.write(PORT_FILE, ''); await Bun.write(TOKEN_FILE, ''); } catch {}

const child = Bun.spawn([process.execPath, 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0', NET_PORT_FILE: PORT_FILE, ADMIN_TOKEN_FILE: TOKEN_FILE, GHOST_LOBBY_MS: '3000' },
  stdout: 'pipe', stderr: 'pipe',
});
const t0 = Date.now();
let port = 0;
while (Date.now() - t0 < 8000) {
  const s = (await Bun.file(PORT_FILE).text()).trim();
  if (s) { port = Number(s); break; }
  await Bun.sleep(50);
}
if (!port) { console.log('FAIL 服务器未启动'); process.exit(1); }
const KEY = (await Bun.file(TOKEN_FILE).text()).trim();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' · ' + extra : ''}`); }
};

const get = async (p, headers) => {
  const r = await fetch(`http://localhost:${port}${p}`, { headers });
  return { status: r.status, body: await r.text() };
};
const jget = async (p) => { const r = await get(p); return { status: r.status, json: r.body.startsWith('{') ? JSON.parse(r.body) : null, text: r.body }; };
const post = async (p, body = {}) => {
  const r = await fetch(`http://localhost:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

ok('口令文件已生成', KEY.length >= 20, `${KEY.length} 位`);
ok('未使用默认 .data 目录', !(await Bun.file(GHOST).exists()));

// ---------- 鉴权 ----------
const noKey = await jget('/api/admin/overview');
ok('无口令 → 401', noKey.status === 401, `status ${noKey.status}`);
const badKey = await jget('/api/admin/overview?key=wrong-key-123456');
ok('错口令 → 401', badKey.status === 401);
const good = await jget(`/api/admin/overview?key=${KEY}`);
ok('正确口令 → 200', good.status === 200 && !!good.json?.server);
ok('overview 指标齐全', ['server', 'rooms', 'players', 'net', 'maps'].every((k) => k in (good.json || {})), Object.keys(good.json || {}).join(','));
ok('sim 频率上报', good.json?.server?.sim_hz === 120 && good.json?.server?.proto === 1);
const bearer = await jget('/api/admin/overview');
const authOk = await get('/api/admin/overview', { authorization: 'Bearer ' + KEY });
ok('Bearer 头同样放行', authOk.status === 200, `未带凭证仍 ${bearer.status}`);

// ---------- 页面 ----------
const page = await get('/admin');
ok('/admin 返回运维台页面', page.status === 200 && page.body.includes('对战运维台') && page.body.includes('/api/admin/overview'));
const login = await fetch(`http://localhost:${port}/admin?key=${KEY}`, { redirect: 'manual' });
ok('/admin?key= 换成 Cookie', login.status === 302 && (login.headers.get('set-cookie') || '').includes('qadmin=' + KEY));
const viaCookie = await get('/api/admin/rooms', { cookie: `qadmin=${KEY}` });
ok('Cookie 鉴权生效', viaCookie.status === 200);

// ---------- 房间实况 ----------
function helloBytes(o) {
  const w = new Writer(160);
  w.u8(C.HELLO).u8(1).str(o.name).u8(o.skin).str(o.map).u8(o.laps).u8(o.mode).u8(o.diff)
    .str(o.code || '').u8(o.create ? 1 : 0).str(o.token || '');
  return w.bytes();
}
class Cli {
  constructor(over = {}) {
    this.opts = { name: '车手', skin: 1, map: 'city', laps: 2, mode: 0, diff: 1, code: '', create: 0, token: '', ...over };
    this.welcome = null;
    this.roster = null;
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((res) => { this.ws.onopen = res; });
    this.ws.onmessage = (e) => this.onMsg(new Uint8Array(e.data));
  }
  onMsg(b) {
    const r = new Reader(b);
    const type = r.u8();
    if (type === S.WELCOME) {
      this.welcome = { car_id: r.u16(), code: r.str(), map: r.str(), laps: r.u8(), mode: r.u8(), phase: r.u8(), tick: r.u32(), seed: r.u32(), grid: r.u8(), snap_hz: r.u8() };
      if (!r.eof) r.u32();
      this.welcome.token = r.str();
    } else if (type === S.ROSTER) {
      r.u8();
      const n = r.u8();
      this.roster = [];
      for (let i = 0; i < n; i++) this.roster.push({ car_id: r.u16(), slot: r.u8(), skin: r.u8(), flags: r.u8(), name: r.str() });
    }
  }
  async ready(on = true) {
    await this.opened;
    this.ws.send(helloBytes(this.opts));
    for (let i = 0; i < 60 && !this.welcome; i++) await Bun.sleep(50);
    const w = new Writer(4); w.u8(C.READY).u8(on ? 1 : 0);
    this.ws.send(w.bytes());
    return this.welcome;
  }
  close() { try { this.ws.close(); } catch {} }
}

const ca = new Cli({ create: 1, name: '甲' });
const cb = new Cli({ code: '', name: '乙' });
const a = await ca.ready();
cb.opts.code = a.code;
const b = await cb.ready();
ok('房间已建立', !!a?.code && !!b?.code && a.code === b.code, a.code);

const rows = await jget(`/api/admin/rooms?key=${KEY}`);
const row = rows.json?.rooms?.find((r) => r.code === a.code);
ok('后台列出该房间', !!row, JSON.stringify(row || {}));
ok('席位/在线计数正确', row?.players === 2 && row?.online === 2, `${row?.online}/${row?.players}`);
ok('房间列表语义一致', row?.listed === true);

const detail = await jget(`/api/admin/rooms/${a.code}?key=${KEY}`);
const d = detail.json;
ok('单房实况可读', detail.status === 200 && Array.isArray(d?.cars), `${d?.cars?.length} 辆车`);
const mine = d?.cars?.find((c) => c.seat_token === a.token);
ok('实况带席位令牌与车手名', !!mine && mine.name === '甲', mine?.name);
ok('实况含网络指标', mine && 'rtt' in mine && 'pending' in mine && 'dropped' in mine && 'bias' in mine);
ok('大厅阶段无 ghost 倒计时', mine?.ghost_left === null, String(mine?.ghost_left));

// ---------- 干预操作 ----------
const bot = await post(`/api/admin/rooms/${a.code}/bot?key=${KEY}`);
const afterBot = await jget(`/api/admin/rooms/${a.code}?key=${KEY}`);
const bots = (afterBot.json?.cars || []).filter((c) => c.bot).length;
ok('加电脑生效', bot.status === 200 && bots === 1, `${bots} 台电脑`);
const badBot = await post(`/api/admin/rooms/ZZZZ/bot?key=${KEY}`);
ok('不存在的房间 → 404', badBot.status === 404);
const noAuth = await post(`/api/admin/rooms/${a.code}/bot`, {});
ok('写操作也要口令', noAuth.status === 401);

const start = await post(`/api/admin/rooms/${a.code}/start?key=${KEY}`);
await Bun.sleep(400);
const racing = await jget(`/api/admin/rooms/${a.code}?key=${KEY}`);
ok('强制开赛生效', start.status === 200 && racing.json?.phase !== PHASE.lobby, `phase ${racing.json?.phase} · state ${racing.json?.state}`);
ok('开赛后有仿真进度', racing.json?.tick > 0, `tick ${racing.json?.tick}`);
const again = await post(`/api/admin/rooms/${a.code}/start?key=${KEY}`);
ok('比赛中不能再强制开赛', again.status === 400 && !!again.json?.error, again.json?.error);

const ov2 = await jget(`/api/admin/overview?key=${KEY}`);
ok('概览统计随实况变化', ov2.json?.players?.bots >= 1 && ov2.json?.rooms?.total >= 1, JSON.stringify(ov2.json?.rooms?.by_phase));

const kick = await post(`/api/admin/rooms/${a.code}/kick?key=${KEY}`, { token: b.token });
const afterKick = await jget(`/api/admin/rooms/${a.code}?key=${KEY}`);
ok('请离席位生效', kick.status === 200 && !afterKick.json?.cars?.some((c) => c.seat_token === b.token));
const kickBad = await post(`/api/admin/rooms/${a.code}/kick?key=${KEY}`, { token: 'nope' });
ok('无效令牌 → 400', kickBad.status === 400, kickBad.json?.error);

const close = await post(`/api/admin/rooms/${a.code}/close?key=${KEY}`);
const rows2 = await jget(`/api/admin/rooms?key=${KEY}`);
ok('关闭房间生效', close.status === 200 && !rows2.json?.rooms?.some((r) => r.code === a.code));
const closed = await jget(`/api/admin/rooms/${a.code}?key=${KEY}`);
ok('关闭后详情 → 404', closed.status === 404);

const notFound = await jget('/api/admin/nope?key=' + KEY);
ok('未知后台接口 → 404', notFound.status === 404);

ca.close(); cb.close();
child.kill();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
