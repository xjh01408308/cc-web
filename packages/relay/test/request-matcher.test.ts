import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { RequestMatcher } from '../src/request-matcher.js';

describe('RequestMatcher — HTTP pending（reqId → cb）', () => {
  it('register + has + take 命中，take 后自动清除', () => {
    const m = new RequestMatcher();
    const cb = vi.fn();
    m.register('r1', cb);
    expect(m.has('r1')).toBe(true);
    expect(m.take('r1')).toBe(cb);
    expect(m.has('r1')).toBe(false);
  });

  it('take 未命中返回 undefined', () => {
    expect(new RequestMatcher().take('nope')).toBeUndefined();
  });

  it('取出 cb 后调用，传入原始 msg', () => {
    const m = new RequestMatcher();
    const cb = vi.fn();
    m.register('r1', cb);
    m.take('r1')!({ ok: true });
    expect(cb).toHaveBeenCalledWith({ ok: true });
  });
});

describe('RequestMatcher — 浏览器请求-响应（含超时清理）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('registerBrowser 返回注入的 reqId', () => {
    const m = new RequestMatcher(() => 'fixed-id');
    expect(m.registerBrowser({} as WebSocket, 'list_sessions')).toBe('fixed-id');
  });

  it('takeBrowser 命中返回 { ws, type } 并清除', () => {
    const m = new RequestMatcher(() => 'r1');
    const ws = {} as WebSocket;
    m.registerBrowser(ws, 'list_projects');
    expect(m.takeBrowser('r1')).toEqual({ ws, type: 'list_projects' });
    expect(m.takeBrowser('r1')).toBeUndefined();
  });

  it('超时后 entry 自动清除（不再 take 到）', () => {
    const m = new RequestMatcher(() => 'r1');
    m.registerBrowser({} as WebSocket, 'x', 10000);
    vi.advanceTimersByTime(10000);
    expect(m.takeBrowser('r1')).toBeUndefined();
  });

  it('超时前 takeBrowser 命中：清掉 timeout，后续 advance 不报错', () => {
    const m = new RequestMatcher(() => 'r1');
    m.registerBrowser({} as WebSocket, 'x', 10000);
    expect(m.takeBrowser('r1')).toBeDefined();
    vi.advanceTimersByTime(10000);
    expect(m.takeBrowser('r1')).toBeUndefined();
  });

  it('forgetBrowser 清掉该 ws 的全部 pending（含 timeout），后续 advance 不报错', () => {
    let n = 0;
    const m = new RequestMatcher(() => 'r' + ++n);
    const ws = {} as WebSocket;
    m.registerBrowser(ws, 'a');
    m.registerBrowser(ws, 'b');
    m.forgetBrowser(ws);
    expect(m.takeBrowser('r1')).toBeUndefined();
    expect(m.takeBrowser('r2')).toBeUndefined();
    vi.advanceTimersByTime(10000);
  });

  it('forgetBrowser 只清目标 ws，不影响其它 ws 的 pending', () => {
    let n = 0;
    const m = new RequestMatcher(() => 'r' + ++n);
    const a = {} as WebSocket;
    const b = {} as WebSocket;
    m.registerBrowser(a, 'a');
    m.registerBrowser(b, 'b');
    m.forgetBrowser(a);
    expect(m.takeBrowser('r1')).toBeUndefined();
    expect(m.takeBrowser('r2')).toEqual({ ws: b, type: 'b' });
  });
});
