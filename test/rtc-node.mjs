// Node/Bun 侧接入 WebRTC 的公共件：把 werift 的 RTCPeerConnection 挂成全局，
// 于是 shared/transport.js 那一份通道代码在浏览器与被测脚本里跑的是同一条路径——不留 WS 旁路。
import { RTCPeerConnection } from 'werift';
import { rtcTransport } from '../shared/transport.js';

globalThis.RTCPeerConnection ??= RTCPeerConnection;

export const signUrl = (port) => `http://localhost:${port}/rtc/offer`;

// 给"自己拼协议帧"的测试用的最小连接：形状与当年的 WS 客户端一致
export class RtcSock {
  constructor(port) {
    this.msgs = [];
    this.waiters = [];
    this.t = rtcTransport(signUrl(port));
    this.t.onMessage = (x) => { this.msgs.push(x); this.onMessage?.(x); this.wake(); };
    this.opened = new Promise((res) => { this.t.onOpen = res; });
    this.closed = new Promise((res) => { this.t.onClose = res; });
    this.t.onError = () => this.t.onClose?.();
  }

  send(bytes) { this.t.send(bytes); }

  // 取第 n 条之后的下一条（协议帧到达是异步的，测试要能等到指定条数）
  async next(after = 0, ms = 4000) {
    const t0 = Date.now();
    while (this.msgs.length <= after) {
      if (Date.now() - t0 > ms) throw new Error(`等不到第 ${after + 1} 条服务端消息`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.msgs[after];
  }

  wake() { for (const w of this.waiters.splice(0)) w(); }

  close() { this.t.close(); }

  get bytesIn() { return this.t.bytesIn; }

  get bytesOut() { return this.t.bytesOut; }
}
