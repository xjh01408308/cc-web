import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { ConnectionHandler } from '../src/ws-relay.js';
import {
  BrowserCommandType,
  BrowserEventType,
  LocalEventType,
  LocalControlType,
} from '../src/types.js';

// 协议 type 值用常量，字段名按 shared union（camelCase）。
// 这些集成测试既是「ConnectionHandler 可测」的兑现，也是重构行为保持的回归网。

const OPEN = 1;

interface MockWs {
  ws: WebSocket;
  sent: unknown[];
  closed: boolean;
  emit: (event: string, ...args: unknown[]) => void;
}

function mockWs(): MockWs {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: unknown[] = [];
  const state = { closed: false };
  const api = {
    readyState: OPEN,
    OPEN,
    send: (data: string) => { sent.push(JSON.parse(data)); },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(cb);
    },
    close: () => { state.closed = true; },
    ping: () => {},
  };
  const emit = (event: string, ...args: unknown[]): void => {
    handlers.get(event)?.forEach((cb) => cb(...args));
  };
  return { ws: api as unknown as WebSocket, sent, get closed() { return state.closed; }, emit };
}

function sendMsg(m: MockWs, msg: Record<string, unknown>): void {
  m.emit('message', Buffer.from(JSON.stringify(msg)));
}

// 注册一个 local 节点（devMode 下默认 token 'dev-token' 放行）
function registerNode(m: MockWs, nodeId: string, opts: { passwordRequired?: boolean; token?: string; workspaceRoot?: string } = {}): void {
  sendMsg(m, {
    type: LocalEventType.Register,
    nodeId,
    token: opts.token ?? 'dev-token',
    passwordRequired: opts.passwordRequired ?? false,
    workspaceRoot: opts.workspaceRoot,
  });
}

describe('ConnectionHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  describe('local 注册', () => {
    it('合法 token：进 registry + 回 Registered + 向后连入的 browser 广播 NodesList', () => {
      const h = new ConnectionHandler();
      const local = mockWs();
      h.handleLocalConnection(local.ws, '10.0.0.1');
      registerNode(local, 'n1', { workspaceRoot: '/a' });
      expect(local.sent).toContainEqual({ type: LocalControlType.Registered });

      const browser = mockWs();
      h.handleBrowserConnection(browser.ws, '1.2.3.4');
      expect(browser.sent).toContainEqual({
        type: BrowserEventType.NodesList,
        nodes: [{ nodeId: 'n1', sessionCount: 0, passwordRequired: false, workspaceRoot: '/a' }],
      });
    });

    it('非法 token：回 error 并 close（节点不进 registry）', () => {
      const h = new ConnectionHandler();
      const local = mockWs();
      h.handleLocalConnection(local.ws, '10.0.0.1');
      registerNode(local, 'n1', { token: 'wrong' });
      expect(local.sent).toContainEqual({ type: 'error', error: '认证失败：token 不匹配' });
      expect(local.closed).toBe(true);
    });
  });

  describe('browser → local 路由', () => {
    it('Chat 无在线节点 → error「未选择节点，请先选择节点」', () => {
      const h = new ConnectionHandler();
      const browser = mockWs();
      h.handleBrowserConnection(browser.ws, '1.2.3.4');
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '未选择节点，请先选择节点' });
    });

    it('Chat 单节点自动选中 → local 收到 chat 命令', () => {
      const h = new ConnectionHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi', projectPath: '/p' });
      expect(local.sent).toContainEqual(expect.objectContaining({
        type: 'chat', sessionId: 's1', text: 'hi', projectPath: '/p',
      }));
    });

    it('Chat 显式 nodeId 离线 → error「节点 X 已离线」', () => {
      const h = new ConnectionHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.Chat, nodeId: 'gone', sessionId: 's1', text: 'hi' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '节点 gone 已离线' });
    });

    it('节点需密码 + browser 未认证 → AuthRequired，local 不收到 chat', () => {
      const h = new ConnectionHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(local, 'n1', { passwordRequired: true });
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      expect(browser.sent).toContainEqual(expect.objectContaining({ type: BrowserEventType.AuthRequired, nodeId: 'n1' }));
      expect(local.sent.find((m) => (m as { type?: string }).type === 'chat')).toBeUndefined();
    });
  });

  describe('会话订阅 + claude_json 广播', () => {
    it('Chat 带 sessionId 订阅：local 发 claude_json 带 sessionId → 该 browser 收到', () => {
      const h = new ConnectionHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(local, 'n1');
      const sub = mockWs(); h.handleBrowserConnection(sub.ws, 'ip');
      const other = mockWs(); h.handleBrowserConnection(other.ws, 'ip');
      sendMsg(sub, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      local.sent.length = 0; sub.sent.length = 0; other.sent.length = 0;

      sendMsg(local, { type: LocalEventType.ClaudeJson, sessionId: 's1', data: { type: 'assistant' } });
      expect(sub.sent.some((m) => (m as { type?: string }).type === 'claude_json')).toBe(true);
      expect(other.sent.some((m) => (m as { type?: string }).type === 'claude_json')).toBe(false);
    });
  });

  describe('StopSession 按 sessionId 找节点', () => {
    it('SessionInfo 绑定后 StopSession → local 收到 stop（即便多节点也不靠自动选）', () => {
      const h = new ConnectionHandler();
      const localA = mockWs(); h.handleLocalConnection(localA.ws, 'ip'); registerNode(localA, 'nA');
      const localB = mockWs(); h.handleLocalConnection(localB.ws, 'ip'); registerNode(localB, 'nB');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      // s1 绑定到 nB
      sendMsg(localB, { type: LocalEventType.SessionInfo, sessionId: 's1', status: 'running', projectPath: '/x' });
      sendMsg(browser, { type: BrowserCommandType.StopSession, sessionId: 's1' });
      expect(localB.sent).toContainEqual(expect.objectContaining({ type: 'stop_session', sessionId: 's1' }));
      expect(localA.sent.find((m) => (m as { type?: string }).type === 'stop_session')).toBeUndefined();
    });
  });

  describe('浏览器请求-响应回程', () => {
    it('ListSessions：browser 发 → local 收到带 _reqId → local 回 sessions_list 带 _reqId → browser 收到（去 _reqId + 加 nodeId）', () => {
      const h = new ConnectionHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.ListSessions });
      const req = local.sent.find((m) => (m as { type?: string }).type === 'list_sessions') as { _reqId?: string };
      expect(req?._reqId).toBeTruthy();

      sendMsg(local, { type: LocalEventType.SessionsList, _reqId: req!._reqId, sessions: [{ sessionId: 's1' }] });
      expect(browser.sent).toContainEqual({ type: 'sessions_list', sessions: [{ sessionId: 's1' }], nodeId: 'n1' });
    });
  });

  describe('ListSessions 离线静默（与 Chat 离线报 error 的不一致行为保持）', () => {
    it('ListSessions 显式 nodeId 离线 → 不回 error、local 不收到请求', () => {
      const h = new ConnectionHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.ListSessions, nodeId: 'gone' });
      expect(browser.sent.find((m) => (m as { type?: string }).type === 'error')).toBeUndefined();
      expect(local.sent.find((m) => (m as { type?: string }).type === 'list_sessions')).toBeUndefined();
    });
  });

  describe('requestLocal（HTTP API）', () => {
    it('无在线节点 → reject「没有在线的本地节点」', async () => {
      const h = new ConnectionHandler();
      await expect(h.requestLocal({ type: 'list_projects' })).rejects.toThrow('没有在线的本地节点');
    });
  });

  describe('AuthNode 超时回归', () => {
    // 重构曾丢失超时分支的 nodeId（成功分支有、超时分支漏）—— 此测试钉住该字段
    it('超时响应必须带 nodeId', () => {
      const h = new ConnectionHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(local, 'n1', { passwordRequired: true });
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      browser.sent.length = 0;
      sendMsg(browser, { type: BrowserCommandType.AuthNode, nodeId: 'n1', password: 'any' });
      // local 收到 auth_node 但故意不回 → 触发 5s 超时
      vi.advanceTimersByTime(5000);
      expect(browser.sent).toContainEqual({ type: BrowserEventType.AuthResult, nodeId: 'n1', success: false, error: '认证超时' });
    });
  });
});
