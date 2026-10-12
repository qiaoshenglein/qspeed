// WebRTC PoC 第二步（真正的关卡）：真实 Chrome ↔ Bun 里的 werift 能不能互通。
// 纯 JS 的 DTLS/SCTP 实现最常翻车的地方就是与 Chrome 的互操作（DTLS 角色、SCTP 分片、ICE 候选），
// 进程内环回跑通不代表浏览器能连上。这一步给出 go/no-go：
//   1) 数据通道能否打开、耗时多少（换传输后"点加入"要等多久）
//   2) 通道往返时延（对比同机 WS）
//   3) 不可靠通道在真实 UDP 环回上的送达率
// 用法：bun test/rtc-browser.mjs
import { chromium } from 'playwright-core';
import { RTCPeerConnection } from 'werift';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const GATE = process.env.GATE === '1';

const PAGE = `<!doctype html><meta charset="utf-8"><body><script>
const ws = new WebSocket('ws://' + location.host + '/sig');
const out = { openMs: 0, rtt: [], got: 0, sent: 0, error: '' };
ws.onopen = async () => {
  try {
    const pc = window.__pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('race', { ordered: false, maxRetransmits: 0 });
    const tOpen = performance.now();
    dc.onopen = () => {
      out.openMs = performance.now() - tOpen;
      // 阶段一：3 秒 PING（16B，带时间戳），服务端原样回显 → 量往返时延
      const iv = setInterval(() => {
        const b = new Uint8Array(16); const dv = new DataView(b.buffer);
        dv.setUint32(0, 0x50494e47); dv.setFloat64(8, performance.now());
        dc.send(b); out.sent++;
      }, 33);
      setTimeout(() => {
        clearInterval(iv);
        // 阶段二：2 秒按 20Hz 推 120B（一份全量快照的量级）→ 量送达率
        let n = 0;
        const iv2 = setInterval(() => { dc.send(new Uint8Array(120)); out.sent++; if (++n >= 40) clearInterval(iv2); }, 50);
        setTimeout(() => { clearInterval(iv2); ws.send(JSON.stringify(out)); }, 2200);
      }, 3000);
    };
    dc.onmessage = (ev) => {
      const b = new Uint8Array(ev.data);
      out.got++;
      if (b.length === 16) { const dv = new DataView(b.buffer); if (dv.getUint32(0) === 0x50494e47) out.rtt.push(performance.now() - dv.getFloat64(8)); }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  } catch (e) { out.error = String(e && e.message || e); ws.send(JSON.stringify(out)); }
};
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'answer') await window.__pc.setRemoteDescription(m);
};
window.onerror = (e) => { out.error = String(e); };
</script></body>`;

let peers = 0;
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/sig') {
      if (!srv.upgrade(req, { data: { pc: null } })) return new Response('sig upgrade failed', { status: 426 });
      return;
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
  websocket: {
    async message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'offer') {
        // 每个玩家一条服务端 PC：与真实服务器的持有方式一致
        const pc = new RTCPeerConnection({ iceServers: [] });
        ws.data.pc = pc;
        peers++;
        pc.onDataChannel.subscribe((ch) => { ch.onmessage = (m) => ch.send(m instanceof Uint8Array ? m : new Uint8Array(m.data ?? m)); });
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp }));
        return;
      }
      // 页面把测量结果回传
      globalThis.__report?.(msg);
    },
    close(ws) { try { ws.data.pc?.close(); } catch { /* 已关 */ } },
  },
  maxPayloadLength: 1 << 20,
});

const result = new Promise((resolve) => { globalThis.__report = resolve; });
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    // headless 里不显式关掉这仨，WebRTC 会一个候选都不收集（ICE 直接失败）
    '--force-webrtc-ip-handling-mode=default_public_interface', '--disable-features=ThirdPartyCookiePhaseout'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const pageErr = [];
page.on('pageerror', (e) => pageErr.push(String(e.message)));
await page.goto(`http://localhost:${server.port}/`);

let res = null;
const timed = await Promise.race([
  result.then((r) => { res = r; return 'ok'; }),
  new Promise((r) => setTimeout(() => r('timeout'), 25000)),
]);

const rt = [...(res?.rtt || [])].sort((a, b) => a - b);
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);
console.log(`通道打开：${res ? res.openMs.toFixed(0) + 'ms' : '未打开'}（服务端 PC ${peers} 条）· 结果 ${timed}`);
if (res?.error) console.log('页面错误：', res.error);
if (pageErr.length) console.log('脚本报错：', pageErr.slice(0, 2).join(' | '));
console.log(`往返时延（Chrome↔Bun，本机 UDP 环回）：中位 ${q(rt, 0.5).toFixed(2)}ms · p95 ${q(rt, 0.95).toFixed(2)}ms · 样本 ${rt.length}`);
console.log(`不可靠通道送达：发出 ${res ? res.sent : 0} 帧 · 收到 ${res ? res.got : 0} 帧 · 丢 ${res ? res.sent - res.got : 0}（${res && res.sent ? ((1 - res.got / res.sent) * 100).toFixed(1) : '?'}%）`);

let fail = 0;
if (GATE) {
  const okOpen = res && res.openMs > 0 && res.openMs < 5000;
  const okRtt = rt.length > 40 && q(rt, 0.5) < 20;
  if (!okOpen) { fail = 1; console.log('FAIL 浏览器与 Bun 的 WebRTC 通道没打通或过慢'); }
  else if (!okRtt) { fail = 1; console.log('FAIL 往返时延不可接受'); }
  else console.log('PASS Chrome ↔ Bun WebRTC 互操作成立');
}
await browser.close();
server.stop(true);
process.exit(fail ? 1 : 0);
