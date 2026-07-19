import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { SessionRouter } from '../src/session-router.js';

function fakeWs(): WebSocket {
  return {} as WebSocket;
}

// 记录 send 调用，便于断言「谁收到了什么」
function recorder(): { send: typeof send; calls: Array<{ ws: WebSocket; data: unknown }> } {
  const calls: Array<{ ws: WebSocket; data: unknown }> = [];
  const send = (ws: WebSocket, data: unknown): void => { calls.push({ ws, data }); };
  return { send, calls };
}

describe('SessionRouter — 会话订阅与定向广播', () => {
  it('subscribe 后 broadcastToSession 送达该 ws', () => {
    const rec = recorder();
    const router = new SessionRouter(rec.send, () => undefined);
    const ws = fakeWs();
    router.addBrowser(ws);
    router.subscribe('s1', ws);
    router.broadcastToSession('s1', { type: 'x' });
    expect(rec.calls).toEqual([{ ws, data: { type: 'x' } }]);
  });

  it('多 browser 订阅同 session：均收到', () => {
    const rec = recorder();
    const router = new SessionRouter(rec.send, () => undefined);
    const a = fakeWs(), b = fakeWs();
    router.addBrowser(a); router.addBrowser(b);
    router.subscribe('s1', a); router.subscribe('s1', b);
    router.broadcastToSession('s1', { t: 1 });
    expect(rec.calls.map((c) => c.ws)).toEqual([a, b]);
  });

  it('未订阅的 session 广播：无人收到、不抛错', () => {
    const rec = recorder();
    const router = new SessionRouter(rec.send, () => undefined);
    router.addBrowser(fakeWs());
    router.broadcastToSession('nope', { t: 1 });
    expect(rec.calls).toHaveLength(0);
  });

  it('removeBrowser 后不再收到 session / all 任何广播', () => {
    const rec = recorder();
    const router = new SessionRouter(rec.send, () => undefined);
    const ws = fakeWs();
    router.addBrowser(ws);
    router.subscribe('s1', ws);
    router.removeBrowser(ws);
    router.broadcastToSession('s1', { t: 1 });
    router.broadcastToAll({ t: 2 });
    expect(rec.calls).toHaveLength(0);
  });

  it('broadcastToAll 送达所有已 addBrowser 的 ws', () => {
    const rec = recorder();
    const router = new SessionRouter(rec.send, () => undefined);
    const a = fakeWs(), b = fakeWs();
    router.addBrowser(a); router.addBrowser(b);
    router.broadcastToAll({ t: 1 });
    expect(rec.calls.map((c) => c.ws)).toEqual([a, b]);
  });

  it('subscribersOf 返回当前订阅数（含 removeBrowser 后递减）', () => {
    const router = new SessionRouter(() => {}, () => undefined);
    const a = fakeWs(), b = fakeWs();
    expect(router.subscribersOf('s1')).toBe(0);
    router.subscribe('s1', a);
    router.subscribe('s1', b);
    expect(router.subscribersOf('s1')).toBe(2);
    router.removeBrowser(a);
    expect(router.subscribersOf('s1')).toBe(1);
  });
});

describe('SessionRouter — broadcastToNodeBrowsers', () => {
  it('选中该节点 + 未选中节点的 browser 收到；选中其它节点的不收到', () => {
    const rec = recorder();
    const selection = new Map<WebSocket, string>();
    const router = new SessionRouter(rec.send, (ws) => selection.get(ws));
    const onN1 = fakeWs();
    const onN2 = fakeWs();
    const unselected = fakeWs();
    selection.set(onN1, 'n1');
    selection.set(onN2, 'n2');
    router.addBrowser(onN1);
    router.addBrowser(onN2);
    router.addBrowser(unselected);
    router.broadcastToNodeBrowsers('n1', { t: 1 });
    const got = new Set(rec.calls.map((c) => c.ws));
    expect(got.has(onN1)).toBe(true);
    expect(got.has(unselected)).toBe(true);
    expect(got.has(onN2)).toBe(false);
  });

  it('removeBrowser 后该 ws 不再被节点广播命中', () => {
    const rec = recorder();
    const selection = new Map<WebSocket, string>();
    const router = new SessionRouter(rec.send, (ws) => selection.get(ws));
    const onN1 = fakeWs();
    selection.set(onN1, 'n1');
    router.addBrowser(onN1);
    router.removeBrowser(onN1);
    router.broadcastToNodeBrowsers('n1', { t: 1 });
    expect(rec.calls).toHaveLength(0);
  });
});
