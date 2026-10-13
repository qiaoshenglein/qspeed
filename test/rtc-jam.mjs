// 快照通道"再也不排空"时服务器必须止损，而不是永久静默丢帧。
// werift 的 bufferedAmount 只在分片完整发出后回退：通道一旦停止排空就永远停在高位，
// 于是背压保护会对这个玩家永久只丢快照——画面定死，客户端还显示"已连接"，一点报错都没有。
// 公网实测见过一次会话累计 220 帧全丢。这里用真实 PC 把 bufferedAmount 钉死在高位，
// 看服务器是不是在第 40 帧（20Hz 约 2 秒）果断断开，并且不误伤正常通道。
import { RTCPeerConnection } from 'werift';
import { createRtcHub } from '../server/rtc.js';
import { S } from '../shared/proto.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(30); } return false; };

const closed = [];
const hub = createRtcHub({ onMessage: () => {}, onClose: (p) => closed.push(p.id) });

const cli = new RTCPeerConnection({ iceServers: [] });
cli.createDataChannel('ctl', { ordered: true });
cli.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
await cli.setLocalDescription(await cli.createOffer());
const ans = await hub.offer({ type: 'offer', sdp: cli.localDescription.sdp });
if (!ans.sdp) { console.log('FAIL 信令没答复', ans.error); process.exit(1); }
await cli.setRemoteDescription({ type: ans.type || 'answer', sdp: ans.sdp });

const peer = [...hub.peers.values()][0];
if (!peer || !(await until(() => peer.fast && peer.fast.readyState === 'open'))) {
  console.log('FAIL 数据通道没起来'); process.exit(1);
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}${x ? ' · ' + x : ''}`)) : (fail++, console.log(`FAIL ${n}${x ? ' · ' + x : ''}`)); };

// 1) 正常通道：连续 200 帧一份都不能丢、连接必须还在
const snap = new Uint8Array([S.SNAP, 1, 2, 3, 4]);
const d0 = hub.info().fastDropped;
for (let i = 0; i < 200; i++) peer.send(snap);
ok('正常通道不误伤', hub.info().fastDropped - d0 === 0 && hub.peers.size === 1, `丢弃 ${hub.info().fastDropped - d0} · 在线 ${hub.peers.size}`);

// 2) 把缓冲钉在高位：模拟"通道不再排空"
Object.defineProperty(peer.fast, 'bufferedAmount', { get: () => 40000, configurable: true });
for (let i = 0; i < 60; i++) peer.send(snap);
const info = hub.info();
ok('连续积压到第 40 帧就断开', closed.length === 1 && info.peers === 0, `断开事件 ${closed.length} · 在线 ${info.peers}`);
ok('断开被计入 jamKilled', info.jamKilled === 1, `jamKilled=${info.jamKilled} · 丢弃 ${info.fastDropped - d0} 帧`);
ok('丢弃数正好停在止损阈值', info.fastDropped - d0 === 40, `实际丢弃 ${info.fastDropped - d0}（期望 40，再多就是该断不断）`);
ok('断开原因写进 lastError 供后台查看', /死链路/.test(info.lastError), info.lastError || '（空）');

cli.close();
hub.stop();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
