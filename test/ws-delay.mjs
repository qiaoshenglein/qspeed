// WebSocket 延迟注入代理：真实服务器 <-> 真实客户端之间加单向延迟与抖动，
// 保持 FIFO（真实 TCP 不会乱序），抖动会造成下行成簇到达——这正是高延迟下抖动的来源。
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function startDelayProxy(realWsUrl, opt) {
  const realHttp = realWsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws$/, '');
  // 页面本身也从代理这个源加载：客户端的 WS 地址是按 location.host 推出来的，
  // 这样真实浏览器里的整局游戏就跑在注入的链路上。
  // 注意：这条路径单独成函数，WebSocket 升级必须留在同步分支里（await 之后就不能 upgrade 了）。
  const forwardHttp = async (req, url) => {
    const r = await fetch(realHttp + url.pathname + url.search, { method: req.method, body: req.body });
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/plain' } });
  };
  const rand = rng(opt.seed || 7);
  const one = (base) => Math.max(0, base + (rand() * 2 - 1) * (opt.jitterMs || 0));
  const stats = { up: 0, down: 0, upBytes: 0, downBytes: 0, badType: 0, badSample: '', noTarget: 0, sendFail: 0, sendZero: 0 };

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== '/ws') return forwardHttp(req, url);
      const data = { up: null, ws: null, open: false, queue: [], lastUp: 0, lastDown: 0 };
      if (!srv.upgrade(req, { data })) return new Response('upgrade failed', { status: 426 });
      const up = new WebSocket(realWsUrl);
      up.binaryType = 'arraybuffer';
      data.up = up;
      up.addEventListener('open', () => {
        data.open = true;
        for (const b of data.queue.splice(0)) up.send(b);
      });
      up.addEventListener('message', (ev) => {
        const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null;
        if (!bytes) { stats.badType++; stats.badSample = String(ev.data?.constructor?.name || typeof ev.data); return; }
        if (!data.ws) { stats.noTarget++; return; }
        stats.down++; stats.downBytes += bytes.byteLength;
        // 成簇到达但不乱序：出队时刻 = max(本条到达+链路延迟, 上一条出队时刻)
        const at = Math.max(Date.now() + one(opt.downMs), data.lastDown);
        data.lastDown = at;
        setTimeout(() => {
          try {
            const n = data.ws.send(bytes);
            // Bun：返回 -1 表示发送缓冲已满、这条被直接丢弃（背压），必须计出来
            if (typeof n === 'number' && n <= 0) stats.sendZero++;
          } catch { stats.sendFail++; }
        }, Math.max(0, at - Date.now()));
      });
      up.addEventListener('close', () => { try { data.ws?.close(); } catch { /* 已关 */ } });
      up.addEventListener('error', () => { try { data.ws?.close(); } catch { /* 已关 */ } });
      return;
    },
    maxPayloadLength: 8192,
    idleTimeout: 60,
    websocket: {
      open(ws) { ws.data.ws = ws; },
      message(ws, raw) {
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (!ws.data.up) return;
        stats.up++; stats.upBytes += bytes.byteLength;
        const send = () => { try { ws.data.up.send(bytes); } catch { /* 已关 */ } };
        if (!ws.data.open) { ws.data.queue.push(bytes); return; }
        const at = Math.max(Date.now() + one(opt.upMs), ws.data.lastUp);
        ws.data.lastUp = at;
        setTimeout(send, Math.max(0, at - Date.now()));
      },
      close(ws) { try { ws.data.up?.close(); } catch { /* 已关 */ } },
    },
  });
  return { port: server.port, url: `ws://localhost:${server.port}/ws`, stats, close: () => server.stop(true) };
}
