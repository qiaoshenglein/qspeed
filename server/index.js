// 在线对战服务端入口：HTTP（页面 + 一次性信令 POST）+ WebRTC 数据通道承载比赛数据
// 用法：bun server/index.js  [PORT=8790]  [NET_PORT_FILE=.tmp/port]
//        [RTC_PORT_RANGE=40000-40100]  [RTC_PUBLIC_IP=1.2.3.4]  （公网部署时两个都要给）
import { Room, readHello } from './room.js';
import { createRtcHub } from './rtc.js';
import { createAdmin } from './admin.js';
import { C, Reader } from '../shared/proto.js';
import { MAPS } from '../src/maps.js';
import { GRID } from '../shared/race.js';

const PORT = Number(process.env.PORT ?? 8790);
const DIST = new URL('../dist/index.html', import.meta.url);
const startedAt = Date.now();

const rooms = new Map(); // code -> Room

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return rooms.has(s) ? makeCode() : s;
}

const app = {
  closeRoom(room) {
    if (rooms.get(room.code) === room) {
      rooms.delete(room.code);
      room.dispose();
    }
  },
  resolve(ws, info) {
    const code = (info.code || '').toUpperCase().trim();
    // 凭令牌回线的玩家可能来自列表/快速匹配，先在他原来的席位所在房间找他
    if (info.token) {
      for (const room of rooms.values()) {
        if (room.seats.has(info.token)) return room;
      }
    }
    if (info.create) {
      const room = new Room(app, makeCode(), info);
      rooms.set(room.code, room);
      return room;
    }
    if (code) {
      let room = rooms.get(code);
      if (!room) {
        room = new Room(app, code, info);
        rooms.set(code, room);
      }
      return room;
    }
    // 快速匹配：同图同圈数同模式、仍在大厅、有空位
    for (const room of rooms.values()) {
      if (!room.inLobby) continue;
      if (room.mapId !== info.map || room.laps !== info.laps || room.mode !== info.mode) continue;
      if (room.full) continue;
      return room;
    }
    const room = new Room(app, makeCode(), info);
    rooms.set(room.code, room);
    return room;
  },
};

const admin = createAdmin({ rooms, app, startedAt: () => startedAt });

async function page() {
  const f = Bun.file(DIST);
  if (!(await f.exists())) {
    return new Response('尚未构建：先运行 bun build.mjs --dev 生成 dist/index.html', { status: 503 });
  }
  return new Response(f, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const hub = createRtcHub({
  // 收到一条数据通道消息：与当年 WS 的 message 回调同一套逻辑
  onMessage(peer, raw) {
    let r;
    try { r = new Reader(raw instanceof Uint8Array ? raw : new Uint8Array(raw)); } catch { return; }
    let type;
    try { type = r.u8(); } catch { return; }
    if (type === C.HELLO) {
      if (peer.data.room) return;
      let info;
      try { r.u8(); info = readHello(r); } catch { return; } // proto 版本由房间校验
      const room = app.resolve(peer, info);
      peer.data.room = room;
      room.onMessage(peer, raw);
      return;
    }
    peer.data.room?.onMessage(peer, raw);
  },
  // 连接断了（通道关 / ICE 失败 / 静默超时）：席位保留，车交给自动驾驶
  onClose(peer) { peer.data.room?.drop(peer); },
});

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/rtc/offer' && req.method === 'POST') {
      return req.json().then((body) => hub.offer(body)).then((r) => Response.json(r));
    }
    if (url.pathname === '/rooms') {
      const list = [...rooms.values()].map((r) => r.summary());
      return Response.json({ rooms: list, server_time: Date.now() });
    }
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true, build: 'qq-speed-net-v2', proto: 1, sim_hz: 120,
        rooms: rooms.size, uptime_ms: Date.now() - startedAt, maps: MAPS.length,
        rtc: hub.info(),
      });
    }
    if (url.pathname === '/debug/rooms') {
      const list = [];
      for (const room of rooms.values()) {
        list.push({
          code: room.code, map: room.mapId, laps: room.laps, phase: room.phase,
          tick: room.world.tick, state: room.world.state, members: room.members.size,
          cars: room.world.cars.map((c) => ({
            id: c.carId, name: c.name, human: c.isPlayer, slot: c.slot, auto: !!c.auto,
            bias: c.bias | 0, s: +c.s.toFixed(2), progress: Math.round(c.progress || 0),
            lap: c.lapsDone, x: +c.x.toFixed(2), z: +c.z.toFixed(2),
            pend: room.world.pendingInputs.get(c.carId)?.size || 0,
            dropped: [...room.members.values()].find((m) => m.car === c)?.dropped || 0,
          })),
        });
      }
      return Response.json({ rooms: list });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return page();
    if (url.pathname === '/admin' || url.pathname.startsWith('/api/admin/')) return admin.fetch(req, url);
    return new Response('not found', { status: 404 });
  },
});

if (process.env.NET_PORT_FILE) {
  Bun.write(process.env.NET_PORT_FILE, String(server.port));
}
await admin.init();
console.log(`赛车对战服务已启动 http://localhost:${server.port}  比赛数据走 WebRTC 数据通道（信令 POST /rtc/offer）`);
console.log(`UDP 端口段 ${hub.info().udpRange} · 对外 advertised 地址 ${hub.info().publicIp}（公网部署需放行该端口段的 UDP，必要时设 RTC_PUBLIC_IP）`);
console.log(`后台运维台 http://localhost:${server.port}/admin?key=${admin.token}  （口令来自 ${admin.tokenSource}，仅本机/局域网可达）`);

export { server, rooms, hub };
