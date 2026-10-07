// 后台运维台（A 层：实时运维，不做持久化统计）
// 只在本机/局域网监听，鉴权用一个访问口令：ADMIN_TOKEN 环境变量优先，
// 否则首次启动随机生成并写入 .data/admin-token，重启后口令不变。
import { MAPS } from '../src/maps.js';
import { GRID } from '../shared/race.js';
import { PHASE } from '../shared/proto.js';

const COOKIE = 'qadmin';
const PHASE_NAME = { [PHASE.lobby]: '大厅', [PHASE.countdown]: '起步', [PHASE.race]: '比赛中', [PHASE.result]: '结算' };

function newToken() {
  const A = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += A[b % A.length];
  return s;
}

async function loadToken() {
  const fromEnv = (process.env.ADMIN_TOKEN || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env ADMIN_TOKEN' };
  const file = process.env.ADMIN_TOKEN_FILE || '.data/admin-token';
  const existing = (await Bun.file(file).text().catch(() => '')).trim();
  if (existing) return { token: existing, source: file };
  const token = newToken();
  await Bun.write(file, token + '\n').catch(() => {});
  return { token, source: `${file}（本次新生成）` };
}

// 常量时间比较，避免局域网里有人对着口令做时序探测
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function createAdmin(ctx) {
  const state = { token: '', source: '', checked: false };

  const json = (o, status = 200, headers = {}) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

  function cookieVal(req) {
    const c = req.headers.get('cookie') || '';
    for (const part of c.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  function authorized(req, url) {
    if (!state.token) return false;
    if (same(cookieVal(req), state.token)) return true;
    if (same(url.searchParams.get('key') || '', state.token)) return true;
    const auth = req.headers.get('authorization') || '';
    return same(auth.replace(/^Bearer\s+/i, ''), state.token);
  }

  function roomsList() {
    return [...ctx.rooms.values()];
  }

  function overview() {
    const rooms = roomsList();
    let seats = 0, online = 0, bots = 0, ghost = 0, conns = 0, rttSum = 0, rttN = 0, dropped = 0;
    const byPhase = { 大厅: 0, 起步: 0, 比赛中: 0, 结算: 0 };
    for (const r of rooms) {
      byPhase[PHASE_NAME[r.phase] || '其他'] = (byPhase[PHASE_NAME[r.phase] || '其他'] || 0) + 1;
      seats += r.seats.size;
      online += r.onlineHumans.length;
      conns += r.members.size;
      for (const m of r.seats.values()) {
        if (!m.online && m.ghostUntil && m.ghostUntil > Date.now()) ghost++;
        if (m.rtt) { rttSum += m.rtt; rttN++; }
        dropped += m.dropped || 0;
      }
      bots += r.world.cars.filter((c) => !c.isPlayer).length;
    }
    return {
      server: {
        build: 'qq-speed-net-v1', proto: 1, sim_hz: 120, snap_hz: 20, grid: GRID,
        uptime_s: Math.round((Date.now() - ctx.startedAt()) / 1000),
        now: Date.now(),
      },
      rooms: { total: rooms.length, by_phase: byPhase, open_slots: rooms.length * GRID - seats },
      players: { seats, online, ghost, bots, listed_rooms: rooms.filter((r) => r.listed).length },
      net: { connections: conns, avg_rtt: rttN ? Math.round(rttSum / rttN) : 0, dropped_inputs: dropped },
      maps: MAPS.map((m) => ({
        id: m.id, name: m.name,
        rooms: rooms.filter((r) => r.mapId === m.id).length,
      })),
    };
  }

  function roomRow(r) {
    return { ...r.summary(), created_ago: Math.round((Date.now() - r.createdAt) / 1000), racing: r.timer !== null };
  }

  async function readBody(req) {
    try { return await req.json(); } catch { return {}; }
  }

  // 返回 Response 表示已处理；返回 null 表示不属于后台路由，交回主服务
  return {
    get token() { return state.token; },
    get tokenSource() { return state.source; },
    async init() {
      const t = await loadToken();
      state.token = t.token;
      state.source = t.source;
      return t;
    },
    // url.pathname 需以 /admin 或 /api/admin 开头
    async fetch(req, url) {
      const p = url.pathname;

      if (p === '/admin' || p === '/admin/') {
        if (!state.checked) { await this.init(); state.checked = true; }
        const key = url.searchParams.get('key') || '';
        // 口令写在地址栏里就换成 Cookie，之后地址栏不用再带 key
        if (key && same(key, state.token)) {
          return new Response(null, {
            status: 302,
            headers: { location: '/admin', 'set-cookie': `${COOKIE}=${state.token}; Path=/; Max-Age=604800; SameSite=Lax` },
          });
        }
        const html = Bun.file(new URL('../dist/admin.html', import.meta.url));
        if (!(await html.exists())) return new Response('后台页面未构建：先运行 bun build.mjs', { status: 503 });
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      if (!p.startsWith('/api/admin/')) return null;
      if (!state.checked) { await this.init(); state.checked = true; }
      if (!authorized(req, url)) return json({ error: 'unauthorized', hint: '访问 http://<本机>:<端口>/admin?key=口令' }, 401);

      if (p === '/api/admin/overview') return json(overview());
      if (p === '/api/admin/rooms') return json({ rooms: roomsList().map(roomRow), server_time: Date.now() });

      const m = /^\/api\/admin\/rooms\/([A-Za-z0-9]+)$/.exec(p);
      if (m && req.method === 'GET') {
        const room = ctx.rooms.get(m[1].toUpperCase());
        if (!room) return json({ error: 'no such room' }, 404);
        return json(room.adminDetail());
      }

      const a = /^\/api\/admin\/rooms\/([A-Za-z0-9]+)\/(close|start|bot|kick)$/.exec(p);
      if (a && req.method === 'POST') {
        const room = ctx.rooms.get(a[1].toUpperCase());
        if (!room) return json({ error: 'no such room' }, 404);
        const body = await readBody(req);
        let err = null;
        switch (a[2]) {
          case 'close':
            ctx.app.closeRoom(room);
            break;
          case 'start':
            err = room.adminForceStart();
            break;
          case 'bot':
            err = room.adminAddBot();
            break;
          case 'kick':
            err = room.adminKick(String(body.token || ''));
            break;
        }
        if (err) return json({ error: err }, 400);
        return json({ ok: true, action: a[2], code: room.code, rooms: ctx.rooms.size });
      }

      return json({ error: 'not found' }, 404);
    },
  };
}
