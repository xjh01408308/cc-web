import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WebSocket } from 'ws';
import { ConnectionHandler, type BrowserSession } from '../src/ws-relay.js';
import { NodeStore } from '../src/node-store.js';
import { AssignmentStore } from '../src/assignment-store.js';
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

// 每例独立临时 db（与 node-store.test 同构）：nodeStore + assignmentStore 共享同库不同表。
let storeCleanup: (() => void) | undefined;
function makeHandler(): { handler: ConnectionHandler; store: NodeStore; assignments: AssignmentStore } {
  const dbPath = path.join(os.tmpdir(), `cc-web-relay-test-${randomUUID()}.db`);
  const store = new NodeStore(dbPath);
  const assignments = new AssignmentStore(dbPath);
  storeCleanup = (): void => {
    store.close();
    assignments.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  };
  return { handler: new ConnectionHandler(store, assignments), store, assignments };
}

// 注册一个 local 节点：先在 nodeStore 预注册拿到明文 secret，再用它 register。
// opts.nodeSecret 显式传值可模拟"错误 secret"；不传则用预注册生成正确 secret。
function registerNode(store: NodeStore, m: MockWs, nodeId: string, opts: { passwordRequired?: boolean; nodeSecret?: string; workspaceRoot?: string } = {}): string {
  const secret = store.createNode(nodeId).secret;
  sendMsg(m, {
    type: LocalEventType.Register,
    nodeId,
    nodeSecret: opts.nodeSecret ?? secret,
    passwordRequired: opts.passwordRequired ?? false,
    workspaceRoot: opts.workspaceRoot,
  });
  return secret;
}

describe('ConnectionHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { storeCleanup?.(); storeCleanup = undefined; vi.clearAllTimers(); vi.useRealTimers(); });

  describe('local 注册', () => {
    it('合法 token：进 registry + 回 Registered + 向后连入的 browser 广播 NodesList', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs();
      h.handleLocalConnection(local.ws, '10.0.0.1');
      registerNode(store, local, 'n1', { workspaceRoot: '/a' });
      expect(local.sent).toContainEqual({ type: LocalControlType.Registered });

      const browser = mockWs();
      h.handleBrowserConnection(browser.ws, '1.2.3.4');
      expect(browser.sent).toContainEqual({
        type: BrowserEventType.NodesList,
        nodes: [{ nodeId: 'n1', sessionCount: 0, passwordRequired: false, workspaceRoot: '/a' }],
      });
    });

    it('错误 nodeSecret：回 error 并 close（节点不进 registry）', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs();
      h.handleLocalConnection(local.ws, '10.0.0.1');
      registerNode(store, local, 'n1', { nodeSecret: 'wrong' });
      expect(local.sent).toContainEqual({ type: 'error', error: '认证失败：节点未预注册或 nodeSecret 不正确' });
      expect(local.closed).toBe(true);
    });

    it('未预注册的 nodeId：同样被拒（不泄露是否存在）', () => {
      const { handler: h } = makeHandler();
      const local = mockWs();
      h.handleLocalConnection(local.ws, '10.0.0.1');
      // 不预注册，直接 register
      sendMsg(local, { type: LocalEventType.Register, nodeId: 'ghost', nodeSecret: 'anything' });
      expect(local.sent).toContainEqual({ type: 'error', error: '认证失败：节点未预注册或 nodeSecret 不正确' });
      expect(local.closed).toBe(true);
    });
  });

  describe('browser → local 路由', () => {
    it('Chat 无在线节点 → error「未选择节点，请先选择节点」', () => {
      const { handler: h, store } = makeHandler();
      const browser = mockWs();
      h.handleBrowserConnection(browser.ws, '1.2.3.4');
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '未选择节点，请先选择节点' });
    });

    it('Chat 单节点自动选中 → local 收到 chat 命令', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi', projectPath: '/p' });
      expect(local.sent).toContainEqual(expect.objectContaining({
        type: 'chat', sessionId: 's1', text: 'hi', projectPath: '/p',
      }));
    });

    it('Chat 显式 nodeId 离线 → error「节点 X 已离线」', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.Chat, nodeId: 'gone', sessionId: 's1', text: 'hi' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '节点 gone 已离线' });
    });

    it('节点需密码 + admin browser → 直接转发 chat（Assignment 模型不再弹密码）', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1', { passwordRequired: true });
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip'); // 默认 admin session
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      // admin 全放行：不再 AuthRequired，chat 直接到 local
      expect(browser.sent.find((m) => (m as { type?: string }).type === 'auth_required')).toBeUndefined();
      expect(local.sent.find((m) => (m as { type?: string }).type === 'chat')).toBeTruthy();
    });
  });

  describe('会话订阅 + claude_json 广播', () => {
    it('Chat 带 sessionId 订阅：local 发 claude_json 带 sessionId → 该 browser 收到', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
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
      const { handler: h, store } = makeHandler();
      const localA = mockWs(); h.handleLocalConnection(localA.ws, 'ip'); registerNode(store, localA, 'nA');
      const localB = mockWs(); h.handleLocalConnection(localB.ws, 'ip'); registerNode(store, localB, 'nB');
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
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
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
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      sendMsg(browser, { type: BrowserCommandType.ListSessions, nodeId: 'gone' });
      expect(browser.sent.find((m) => (m as { type?: string }).type === 'error')).toBeUndefined();
      expect(local.sent.find((m) => (m as { type?: string }).type === 'list_sessions')).toBeUndefined();
    });
  });

  describe('requestLocal（HTTP API）', () => {
    it('无在线节点 → reject「没有在线的本地节点」', async () => {
      const { handler: h, store } = makeHandler();
      await expect(h.requestLocal({ type: 'list_projects' })).rejects.toThrow('没有在线的本地节点');
    });
  });

  describe('AuthNode 超时重试（跨公网丢包容错）', () => {
    it('5s 超时后重发一次 → local 收到两次 auth_node，浏览器尚未收到失败', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1', { passwordRequired: true });
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      browser.sent.length = 0; local.sent.length = 0;
      sendMsg(browser, { type: BrowserCommandType.AuthNode, nodeId: 'n1', password: 'any' });
      expect(local.sent.filter((m) => (m as { type?: string }).type === 'auth_node')).toHaveLength(1);
      // local 一直不回 → 5s 后重发
      vi.advanceTimersByTime(5000);
      expect(local.sent.filter((m) => (m as { type?: string }).type === 'auth_node')).toHaveLength(2);
      // 浏览器尚未收到 auth_result（重试窗口内不报失败）
      expect(browser.sent.find((m) => (m as { type?: string }).type === 'auth_result')).toBeUndefined();
    });

    it('两次都超时 → 报"认证超时"（带 nodeId）', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1', { passwordRequired: true });
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      browser.sent.length = 0;
      sendMsg(browser, { type: BrowserCommandType.AuthNode, nodeId: 'n1', password: 'any' });
      vi.advanceTimersByTime(5000);  // 首次超时 → 重发
      vi.advanceTimersByTime(5000);  // 二次超时 → 报失败
      expect(browser.sent).toContainEqual({ type: BrowserEventType.AuthResult, nodeId: 'n1', success: false, error: '认证超时' });
    });

    it('首次丢包、重试时 local 回包 → 认证成功（迟到回包无害）', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1', { passwordRequired: true });
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip');
      browser.sent.length = 0; local.sent.length = 0;
      sendMsg(browser, { type: BrowserCommandType.AuthNode, nodeId: 'n1', password: 'any' });
      const req = local.sent.find((m) => (m as { type?: string }).type === 'auth_node') as { _reqId?: string };
      vi.advanceTimersByTime(5000);  // 首次超时 → 重发（同 _reqId）
      // local 对重发的 auth_node 回成功
      sendMsg(local, { type: LocalEventType.AuthResult, _reqId: req!._reqId, success: true });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.AuthResult, nodeId: 'n1', success: true });
    });
  });

  describe('local 链路假死检测', () => {
    it('local 超过 LOCAL_IDLE_TIMEOUT_MS(90s) 无任何消息 → 心跳主动关闭触发重连', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      expect(local.closed).toBe(false);
      // local 既不回 pong 也不发任何消息 → 3 个 ping 周期（90s）后判定假死
      vi.advanceTimersByTime(90000);
      expect(local.closed).toBe(true);
    });

    it('local 正常回 pong → 持续活跃，不关闭', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      // 每个 ping 周期内 local 回 pong，模拟链路正常
      vi.advanceTimersByTime(30000);
      sendMsg(local, { type: LocalEventType.Pong });
      vi.advanceTimersByTime(30000);
      sendMsg(local, { type: LocalEventType.Pong });
      vi.advanceTimersByTime(30000);
      expect(local.closed).toBe(false);
    });
  });

  describe('按 user 过滤节点列表（Assignment）', () => {
    const userSession: BrowserSession = { userId: 'u1', username: 'alice', role: 'user' };
    const adminSession: BrowserSession = { userId: 'a1', username: 'admin', role: 'admin' };

    function nodesListEv(sent: unknown[]): { nodeId: string }[] | undefined {
      const ev = sent.find((m) => (m as { type?: string }).type === BrowserEventType.NodesList) as { nodes: { nodeId: string }[] } | undefined;
      return ev?.nodes;
    }

    it('user 连接：只见 assigned ∩ online 的节点（未分配不可见）', () => {
      const { handler: h, store, assignments } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip');
      registerNode(store, local, 'n1'); registerNode(store, local, 'n2');
      assignments.assign('u1', 'n1'); // 仅分配 n1
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      expect(nodesListEv(browser.sent)?.map((n) => n.nodeId)).toEqual(['n1']);
    });

    it('user 无任何 assignment → 连接时不发 nodes_list', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      expect(nodesListEv(browser.sent)).toBeUndefined();
    });

    it('admin 连接：见全部在线节点', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip');
      registerNode(store, local, 'n1'); registerNode(store, local, 'n2');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', adminSession);
      expect(nodesListEv(browser.sent)?.map((n) => n.nodeId).sort()).toEqual(['n1', 'n2']);
    });

    it('ListNodes 命令 → user 收到过滤后的列表', () => {
      const { handler: h, store, assignments } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip');
      registerNode(store, local, 'n1'); registerNode(store, local, 'n2');
      assignments.assign('u1', 'n2');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      browser.sent.length = 0;
      sendMsg(browser, { type: BrowserCommandType.ListNodes });
      expect(nodesListEv(browser.sent)?.map((n) => n.nodeId)).toEqual(['n2']);
    });

    it('节点上线广播 → 每 user 收到各自过滤后的列表（admin 全、user 仅 assigned）', () => {
      const { handler: h, store, assignments } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip');
      registerNode(store, local, 'n1');
      assignments.assign('u1', 'n1'); assignments.assign('u1', 'n2');
      const user = mockWs(); h.handleBrowserConnection(user.ws, 'ip', userSession);
      const admin = mockWs(); h.handleBrowserConnection(admin.ws, 'ip', adminSession);
      user.sent.length = 0; admin.sent.length = 0;
      registerNode(store, local, 'n2'); // n2 上线 → 广播
      expect(nodesListEv(user.sent)?.map((n) => n.nodeId).sort()).toEqual(['n1', 'n2']);
      expect(nodesListEv(admin.sent)?.map((n) => n.nodeId).sort()).toEqual(['n1', 'n2']);
    });

    it('节点上线但 user 未分配 → user 列表不含该节点', () => {
      const { handler: h, store, assignments } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip');
      registerNode(store, local, 'n1');
      assignments.assign('u1', 'n1');
      const user = mockWs(); h.handleBrowserConnection(user.ws, 'ip', userSession);
      user.sent.length = 0;
      registerNode(store, local, 'nX'); // 未分配给 u1
      expect(nodesListEv(user.sent)?.map((n) => n.nodeId)).toEqual(['n1']);
    });
  });

  describe('操作授权判定（Assignment，替代 NodeAuth isAuthenticated）', () => {
    const userSession: BrowserSession = { userId: 'u1', username: 'alice', role: 'user' };
    const adminSession: BrowserSession = { userId: 'a1', username: 'admin', role: 'admin' };

    it('user 对未分配节点 Chat → error「无权访问」，local 不收到 chat', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '无权访问节点 n1' });
      expect(local.sent.find((m) => (m as { type?: string }).type === 'chat')).toBeUndefined();
    });

    it('user 对已分配节点 Chat → 正常转发到 local', () => {
      const { handler: h, store, assignments } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      assignments.assign('u1', 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi', projectPath: '/p' });
      expect(local.sent).toContainEqual(expect.objectContaining({ type: 'chat', sessionId: 's1', text: 'hi' }));
    });

    it('授权实时：分配后即可操作（每命令查 DB）', () => {
      const { handler: h, store, assignments } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '无权访问节点 n1' });
      assignments.assign('u1', 'n1'); // 运行中分配 → 立即生效
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's2', text: 'ok' });
      expect(local.sent.find((m) => (m as { type?: string; sessionId?: string }).type === 'chat' && (m as { sessionId?: string }).sessionId === 's2')).toBeTruthy();
    });

    it('admin 对任意节点 Chat → 放行（即便未分配）', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', adminSession);
      sendMsg(browser, { type: BrowserCommandType.Chat, sessionId: 's1', text: 'hi' });
      expect(browser.sent.find((m) => (m as { type?: string }).type === 'error')).toBeUndefined();
      expect(local.sent.find((m) => (m as { type?: string }).type === 'chat')).toBeTruthy();
    });

    it('user 对未分配节点发 StopSession（按会话找节点）→ error，local 不收到', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      sendMsg(local, { type: LocalEventType.SessionInfo, sessionId: 's1', status: 'running', projectPath: '/x' });
      sendMsg(browser, { type: BrowserCommandType.StopSession, sessionId: 's1' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '无权访问节点 n1' });
      expect(local.sent.find((m) => (m as { type?: string }).type === 'stop_session')).toBeUndefined();
    });

    it('user SelectNode 未分配节点 → 回「不在线」（不泄露存在性），不选中', () => {
      const { handler: h, store } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      sendMsg(browser, { type: BrowserCommandType.SelectNode, nodeId: 'n1' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.Error, error: '节点 n1 不在线' });
      expect(browser.sent.find((m) => (m as { type?: string }).type === BrowserEventType.NodeSelected)).toBeUndefined();
    });

    it('user SelectNode 已分配节点 → NodeSelected', () => {
      const { handler: h, store, assignments } = makeHandler();
      const local = mockWs(); h.handleLocalConnection(local.ws, 'ip'); registerNode(store, local, 'n1');
      assignments.assign('u1', 'n1');
      const browser = mockWs(); h.handleBrowserConnection(browser.ws, 'ip', userSession);
      sendMsg(browser, { type: BrowserCommandType.SelectNode, nodeId: 'n1' });
      expect(browser.sent).toContainEqual({ type: BrowserEventType.NodeSelected, nodeId: 'n1' });
    });
  });
});
