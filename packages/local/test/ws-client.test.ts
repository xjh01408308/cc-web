// ws-client relay 假死监测（T7，#26）回归测试。
//
// 单一 seam：ws-client 模块 export 边界（start / stop）。
//   驱动 = mock 掉 'ws' 模块，拿到 fake ws 实例后手动 emit open/message/close，
//           用 fake timers 推进时间模拟「relay 停发消息」；
//   观察 = fake ws 是否被 close + 是否产生新连接（重连）。
//
// 覆盖 acceptance：
//   - relay 停发 Ping 但不断 TCP → local 在阈值内主动断开并重连（走现有指数退避）
//   - relay 持续发消息 → idle 定时器不断重置，不误断
//   - RELAY_IDLE_TIMEOUT_MS 可配（env 覆盖默认 90s）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factory 在 import 前运行，需 hoisted 持有 fake 实例注册表
const { sockets } = vi.hoisted(() => ({ sockets: [] as Array<FakeWs> }));

class FakeWs {
  static readonly OPEN = 1;
  readyState = 1;
  closed = false;
  sent: unknown[] = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(public url: string) {
    sockets.push(this);
  }
  on(event: string, cb: (...args: unknown[]) => void): void {
    let arr = this.handlers.get(event);
    if (!arr) { arr = []; this.handlers.set(event, arr); }
    arr.push(cb);
  }
  // 真实 ws 库里 onclose/onerror 是 setter：赋函数=替换该事件监听，赋 null=移除。
  // stop()/connect() 用 `ws.onclose = null` 解绑，mock 需同等行为才不漏触发 close 回调。
  set onclose(cb: ((...args: unknown[]) => void) | null) { this.handlers.set('close', cb ? [cb] : []); }
  set onerror(cb: ((...args: unknown[]) => void) | null) { this.handlers.set('error', cb ? [cb] : []); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  // close 同步触发 'close'，让 close 回调（清 idle 定时器 + 调度重连）自然走完
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 1000, Buffer.alloc(0));
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((cb) => cb(...args));
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWs }));

type WsClientModule = typeof import('../src/ws-client.js');
let mod: WsClientModule;

beforeEach(() => {
  vi.resetModules();
  sockets.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  mod?.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  sockets.length = 0;
  delete process.env.RELAY_IDLE_TIMEOUT_MS;
});

describe('ws-client relay 假死监测', () => {
  it('relay 停发 Ping 但不断 TCP → local 在阈值内主动断开并重连（模拟 relay 假死）', async () => {
    mod = await import('../src/ws-client.js');
    mod.start();
    const s1 = sockets[0];
    s1.emit('open');
    // 先模拟 relay 正常发 Ping：链路活着，idle 计时每次被重置
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(30000);
      s1.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    }
    expect(s1.closed).toBe(false); // t=90s，持续收 Ping 故未断

    // relay 假死：停发 Ping 但 TCP 仍 OPEN（不再 emit 任何 message）
    vi.advanceTimersByTime(89000);
    expect(s1.closed).toBe(false); // 阈值内
    vi.advanceTimersByTime(2000); // 越过 90s 阈值 → idle 触发 → close
    expect(s1.closed).toBe(true);

    // close 回调走现有指数退避：RECONNECT_DELAY(2s) 到期 → 建立新连接
    vi.advanceTimersByTime(2000);
    expect(sockets.length).toBe(2);
  });

  it('relay 持续发 Ping → idle 定时器不断重置，不误断', async () => {
    mod = await import('../src/ws-client.js');
    mod.start();
    const s1 = sockets[0];
    s1.emit('open');
    // 每 30s 收到 relay Ping（< 90s 阈值）→ 每次重置 idle 计时
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30000);
      s1.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    }
    expect(s1.closed).toBe(false);
  });

  it('收到不可解析的字节也算链路活着 → 重置 idle，不误断', async () => {
    mod = await import('../src/ws-client.js');
    mod.start();
    const s1 = sockets[0];
    s1.emit('open');
    // relay 发来坏数据（JSON 解析失败），但字节已到 = 链路活着，应重置 idle
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30000);
      s1.emit('message', Buffer.from('not-json'));
    }
    expect(s1.closed).toBe(false);
  });

  it('RELAY_IDLE_TIMEOUT_MS 可配：env=5s → 按 5s 阈值断开（非默认 90s）', async () => {
    process.env.RELAY_IDLE_TIMEOUT_MS = '5000';
    vi.resetModules();
    mod = await import('../src/ws-client.js');
    mod.start();
    const s1 = sockets[0];
    s1.emit('open'); // arm idle(5s)
    vi.advanceTimersByTime(4000);
    expect(s1.closed).toBe(false);
    vi.advanceTimersByTime(2000); // 越过 5s 阈值
    expect(s1.closed).toBe(true);
  });
});
