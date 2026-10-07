// 在线对战服务端入口：Bun.serve 内置 WebSocket + 房间路由 + 静态站点
// 用法：bun server/index.js  [PORT=8790]  [NET_PORT_FILE=.tmp/port]
import { Room, readHello } from './room.js';
import { C, Reader } from '../shared/proto.js';
import { MAPS } from '../src/maps.js';
import { GRID } from '../shared/race.js';

const PORT = Number(process.env.PORT ?? 8790);
const DIST = new URL('../dist/index.html', import.meta.url);
const startedAt = Date.now();

const rooms = new Map(); // code -> Room
let connSeq = 1;

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

async function page() {
  const f = Bun.file(DIST);
  if (!(await f.exists())) {
    return new Response('尚未构建：先运行 bun build.mjs --dev 生成 dist/index.html', { status: 503 });
  }
  return new Response(f, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const server = Bun.serve({
  port: PORT,
  // eslint-disable-next-line no-control-regex
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (srv.upgrade(req, { data: { connId: connSeq++, room: null } })) return;
      return new Response('websocket upgrade failed', { status: 426 });
    }
    if (url.pathname === '/rooms') {
      const list = [...rooms.values()].map((r) => r.summary());
      return Response.json({ rooms: list, server_time: Date.now() });
    }
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true, build: 'qq-speed-net-v1', proto: 1, sim_hz: 120,
        rooms: rooms.size, uptime_ms: Date.now() - startedAt, maps: MAPS.length,
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
    return new Response('not found', { status: 404 });
  },
  maxPayloadLength: 8192,
  idleTimeout: 60,
  websocket: {
    open() { /* 等 HELLO */ },
    message(ws, raw) {
      let r;
      try { r = new Reader(raw instanceof Uint8Array ? raw : new Uint8Array(raw)); } catch { return; }
      let type;
      try { type = r.u8(); } catch { return; }
      if (type === C.HELLO) {
        if (ws.data.room) return;
        let info;
        try { r.u8(); info = readHello(r); } catch { return; } // proto 版本由房间校验
        const room = app.resolve(ws, info);
        ws.data.room = room;
        room.onMessage(ws, raw);
        return;
      }
      ws.data.room?.onMessage(ws, raw);
    },
    close(ws) {
      ws.data.room?.drop(ws);
    },
  },
});

if (process.env.NET_PORT_FILE) {
  Bun.write(process.env.NET_PORT_FILE, String(server.port));
}
console.log(`赛车对战服务已启动 http://localhost:${server.port}  (ws://localhost:${server.port}/ws)`);

export { server, rooms };
