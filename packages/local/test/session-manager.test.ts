// 领域层（session-manager）回归测试。
//
// 单一 seam：领域层 export 函数边界。
//   驱动 = 调用 export 函数（createSession / sendMessage / switchPermissionMode /
//           retryWithPermission / stopSession）；
//   观察 = mock 传输收集事件 + mock 下游（db / fs / SessionRunner）验证调用。
//   createRunner 的 onMessage 回调（去重 / init 捕获 / 结果收尾）通过 mock
//   SessionRunner 暴露的 options.onMessage 句柄在 seam 内手动触发——不另开 seam。
//
// 这些测试既是「领域层可测」的兑现，也是依赖反转（ws-client → setTransport 注入）
// behavior-preserving 的回归网：断言编码领域层对外契约，反转前后断言不变。
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── hoisted 共享收集器（vi.mock factory 在 import 前运行，需 hoisted 持有）────
const { transportEvents, runnerInstances } = vi.hoisted(() => ({
  // 传输出口事件收集器（send 的全部实参，按序）
  transportEvents: [] as unknown[],
  // mock SessionRunner 实例注册表（按创建序）
  runnerInstances: [] as Array<MockRunner>,
}));

// ─── 传输层 mock（反转后形态：经 setTransport 注入 mock sender 收集器）──────────
//   断言不变，仅注入方式随形态切换（反转前 mock send/isConnected，反转后注入 sender）。

// ─── db mock：所有函数为 spy，createSession 返回默认 SessionRow ────────────────
vi.mock('../src/db.js', () => ({
  createProject: vi.fn(() => ({ id: 'p-id', name: 'n', path: 'p', created_at: 1 })),
  listProjects: vi.fn(() => []),
  getProject: vi.fn(() => ({ id: 'p-id', name: 'n', path: '/proj', created_at: 1 })),
  deleteProject: vi.fn(() => true),
  createSession: vi.fn((_id: string, _pid: string) => ({
    id: 'sid', project_id: 'p-id', summary: '', status: 'idle',
    message_count: 0, created_at: 123, claude_session_id: null,
  })),
  getSession: vi.fn(() => undefined),
  listSessionsByProject: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  updateSessionSummary: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionClaudeId: vi.fn(),
  incrementMessageCount: vi.fn(),
}));

// ─── SessionRunner mock：捕获 options（含 onMessage），暴露 start/send/close spy ─
interface MockRunner {
  options: {
    claudeSessionId?: string;
    projectPath: string;
    model?: string;
    permissionMode?: string;
    signal: AbortSignal;
    onMessage: (resp: unknown) => void;
  };
  start: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

vi.mock('../src/sdk-runner.js', () => {
  class FakeRunner {
    options: MockRunner['options'];
    start = vi.fn();
    send = vi.fn(() => true);
    close = vi.fn();
    constructor(options: MockRunner['options']) {
      this.options = options;
      runnerInstances.push(this as unknown as MockRunner);
    }
  }
  return { SessionRunner: FakeRunner };
});

// ─── file-utils mock：validateProjectPath 永远放行（隔离 WORKSPACE_ROOT 配置）────
vi.mock('../src/file-utils.js', () => ({
  validateProjectPath: vi.fn(() => null),
  getFileTree: vi.fn(),
  getFileContent: vi.fn(),
}));

// ─── fs mock：隔离 Session 消息持久化目录污染 ──────────────────────────────────
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  unlinkSync: vi.fn(),
}));

// import 必须在所有 vi.mock 之后（vitest 将 vi.mock 提升到文件顶部）
import * as db from '../src/db.js';
import {
  createSession,
  sendMessage,
  switchPermissionMode,
  retryWithPermission,
  stopSession,
  getSession,
  setTransport,
  listSessions,
  getHistoryPage,
} from '../src/session-manager.js';

// 反转后形态：注入 mock sender 收集器到领域层（替代反转前的 vi.mock(ws-client)）
setTransport((e) => {
  transportEvents.push(e);
});

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/proj';

function newSession(): string {
  const info = createSession(PROJECT_ID, PROJECT_PATH, undefined, 'acceptEdits');
  return info.sessionId;
}

/** 取最近创建的 mock runner（用于手动触发其 onMessage 模拟 CLI 流式输出） */
function lastRunner(): MockRunner {
  const r = runnerInstances[runnerInstances.length - 1];
  if (!r) throw new Error('尚未创建 SessionRunner');
  return r;
}

beforeEach(() => {
  transportEvents.length = 0;
  runnerInstances.length = 0;
  vi.clearAllMocks();
});

// ─── createSession ────────────────────────────────────────────────────────────

describe('createSession', () => {
  it('创建会话：返回 SessionInfo + 调用 db.createSession + 不产生传输事件', () => {
    const info = createSession(PROJECT_ID, PROJECT_PATH, 'claude-x', 'acceptEdits');

    expect(info.projectId).toBe(PROJECT_ID);
    expect(info.projectPath).toBe(PROJECT_PATH);
    expect(info.model).toBe('claude-x');
    expect(info.permissionMode).toBe('acceptEdits');
    expect(info.status).toBe('idle');
    expect(info.messageCount).toBe(0);
    expect(db.createSession).toHaveBeenCalledTimes(1);
    expect(transportEvents).toEqual([]);
  });
});

// ─── sendMessage + onMessage：流式转发 / init 捕获 / UUID 去重 ─────────────────

describe('sendMessage — runner 流式消息转发', () => {
  it('首次消息：创建并启动 runner，转发用户文本到 runner.send，状态置 running', () => {
    const sid = newSession();

    const ok = sendMessage(sid, 'hello');

    expect(ok).toBe(true);
    const runner = lastRunner();
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(runner.send).toHaveBeenCalledWith('hello');
  });

  it('onMessage 流式消息：转发 claude_json 事件（附加 sessionId）到传输', () => {
    const sid = newSession();
    sendMessage(sid, 'hello');

    const runner = lastRunner();
    const data = { type: 'assistant', uuid: 'u-1', content: [] };
    runner.options.onMessage({ type: 'claude_json', data });

    expect(transportEvents).toEqual([
      { type: 'claude_json', sessionId: sid, data },
    ]);
  });

  it('onMessage init：捕获 claudeSessionId 并写库（仅首次）', () => {
    const sid = newSession();
    sendMessage(sid, 'hello');
    const runner = lastRunner();

    runner.options.onMessage({
      type: 'claude_json',
      data: { type: 'system', subtype: 'init', session_id: 'cs-1', uuid: 'u-init' },
    });

    expect(db.updateSessionClaudeId).toHaveBeenCalledWith(sid, 'cs-1');
    // 第二次 init 不再写库（claudeSessionId 已设置）
    runner.options.onMessage({
      type: 'claude_json',
      data: { type: 'system', subtype: 'init', session_id: 'cs-2', uuid: 'u-init-2' },
    });
    expect(db.updateSessionClaudeId).toHaveBeenCalledTimes(1);
  });

  it('onMessage UUID 去重：相同 uuid 重放只转发一次（--resume 重放场景）', () => {
    const sid = newSession();
    sendMessage(sid, 'hello');
    const runner = lastRunner();

    const data = { type: 'assistant', uuid: 'dup', content: [] };
    runner.options.onMessage({ type: 'claude_json', data });
    runner.options.onMessage({ type: 'claude_json', data });

    // 只有一条 claude_json 事件到达传输
    expect(transportEvents.filter((e) => (e as { type: string }).type === 'claude_json')).toHaveLength(1);
  });
});

// ─── onMessage result：完成通知 + 状态收尾 ─────────────────────────────────────

describe('onMessage result — 本轮对话完成', () => {
  it('result 消息：状态置 idle + 发送 Done 事件 + 增计数 + 持久化', () => {
    const sid = newSession();
    sendMessage(sid, 'hello');
    const runner = lastRunner();

    runner.options.onMessage({
      type: 'claude_json',
      data: { type: 'result', uuid: 'u-result', subtype: 'success' },
    });

    expect(db.updateSessionStatus).toHaveBeenCalledWith(sid, 'idle');
    expect(db.incrementMessageCount).toHaveBeenCalledWith(sid);
    expect(transportEvents).toContainEqual({ type: 'done', sessionId: sid });
  });
});

// ─── sendMessage 失败：进程异常通知 ───────────────────────────────────────────

describe('sendMessage — runner.send 失败', () => {
  it('runner.send 返回 false：状态置 error + 发送 Error 事件 + 返回 false', () => {
    const sid = newSession();
    sendMessage(sid, 'hello'); // 先建 runner
    lastRunner().send.mockReturnValue(false);

    transportEvents.length = 0; // 清掉前面建 runner 阶段的事件
    const ok = sendMessage(sid, 'second');

    expect(ok).toBe(false);
    expect(db.updateSessionStatus).toHaveBeenCalledWith(sid, 'error');
    expect(transportEvents).toContainEqual({
      type: 'error', sessionId: sid, error: 'Claude CLI 进程异常',
    });
  });
});

// ─── switchPermissionMode：运行中重试 + 模式切换通知 ───────────────────────────

describe('switchPermissionMode — 即时切换（--resume 重建）', () => {
  it('运行中切换：关闭旧 runner，用 --resume 重建并重发末条用户消息，发 SessionInfo 事件', () => {
    const sid = newSession();
    sendMessage(sid, 'hello'); // runner 建立，lastUserText='hello'
    // 模拟此前已捕获 claudeSessionId（switchPermissionMode 仅在有 claudeSessionId 时 --resume）
    const runner = lastRunner();
    runner.options.onMessage({
      type: 'claude_json',
      data: { type: 'system', subtype: 'init', session_id: 'cs-1', uuid: 'u-init' },
    });
    // 此时 status 已是 running（sendMessage 置位）

    transportEvents.length = 0;
    const ok = switchPermissionMode(sid, 'bypassPermissions');

    expect(ok).toBe(true);
    const newRunner = lastRunner();
    expect(newRunner.options.claudeSessionId).toBe('cs-1'); // --resume
    expect(newRunner.options.permissionMode).toBe('bypassPermissions');
    expect(newRunner.start).toHaveBeenCalledTimes(1);
    // 运行中重试：重发末条用户消息
    expect(newRunner.send).toHaveBeenCalledWith('hello');
    // 模式切换通知：SessionInfo 事件携带新模式
    expect(transportEvents).toContainEqual(expect.objectContaining({
      type: 'session_info', sessionId: sid, permissionMode: 'bypassPermissions',
    }));
  });
});

// ─── retryWithPermission：消息回滚 + 重放 ─────────────────────────────────────

describe('retryWithPermission — 拒绝回复回滚 + 重放', () => {
  it('从末尾移除非 user 消息直到 user 消息，重置 seenUuids，重建 runner 并重发', () => {
    const sid = newSession();
    sendMessage(sid, 'hello'); // 入队 user 消息 + lastUserText='hello'
    const runner = lastRunner();
    // 模拟被拒绝的 assistant 回复（两条，带 uuid 进 seenUuids）
    runner.options.onMessage({ type: 'claude_json', data: { type: 'assistant', uuid: 'u-a1' } });
    runner.options.onMessage({ type: 'claude_json', data: { type: 'assistant', uuid: 'u-a2' } });
    runner.options.onMessage({
      type: 'claude_json',
      data: { type: 'system', subtype: 'init', session_id: 'cs-1', uuid: 'u-init' },
    });

    // 回滚前：[user, assistant1, assistant2, init-system]
    // 注：init-system 的 data.type 是 'system'（非 'user'），会被 pop
    const ok = retryWithPermission(sid, 'bypassPermissions');

    expect(ok).toBe(true);
    // 消息回滚后应只剩 user 消息
    const session = getSession(sid) as { messages: unknown[] };
    const types = session.messages.map(
      (m) => ((m as { data?: { type?: string } }).data?.type),
    );
    expect(types).toEqual(['user']);
    // 新 runner 已建立并重发末条用户消息
    const newRunner = lastRunner();
    expect(newRunner.send).toHaveBeenCalledWith('hello');
    expect(newRunner.options.permissionMode).toBe('bypassPermissions');
  });
});

// ─── stopSession：会话结束通知 ─────────────────────────────────────────────────

describe('stopSession — 会话结束', () => {
  it('关闭 runner，状态置 idle，发送 SessionEnd 事件', () => {
    const sid = newSession();
    sendMessage(sid, 'hello'); // runner 建立
    const runner = lastRunner();

    transportEvents.length = 0;
    const ok = stopSession(sid);

    expect(ok).toBe(true);
    expect(runner.close).toHaveBeenCalledTimes(1);
    expect(db.updateSessionStatus).toHaveBeenCalledWith(sid, 'idle');
    expect(transportEvents).toContainEqual({ type: 'session_end', sessionId: sid, reason: 'stopped' });
  });
});

// ─── listSessions：列表仅元数据（不含 messages）──────────────────────────────
// 回归点：早期 listSessions 给每行附 messages，导致一个累积数万条消息的会话
// 让列表 payload 达 20MB+，经公网 WS 传输 >5s 撞穿 HTTP 超时 → 列表加载失败。
// 历史改由 get_history 按需单会话拉取，列表只回元数据。
describe('listSessions — 列表仅元数据', () => {
  it('会话有历史消息时，listSessions 返回项也不带 messages', () => {
    const sid = newSession();
    sendMessage(sid, 'hello'); // 入队 user 消息 → 内存会话有历史

    vi.mocked(db.listSessionsByProject).mockReturnValue([
      { id: sid, project_id: PROJECT_ID, summary: '', status: 'idle', message_count: 1, created_at: 123 },
    ]);

    const list = listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(sid);
    expect(list[0].messageCount).toBe(1);
    // 关键回归：列表项不带 messages
    expect(list[0].messages).toBeUndefined();
    // 内存会话本身仍保留 messages（get_history 仍可取到）
    expect(getSession(sid)?.messages.length).toBeGreaterThan(0);
  });
});

// ─── getHistoryPage：从最近往前分页（前端逐步刷新的后端支撑）──────────────────
// 回归点：早期 get_history 一次性回全量 messages，大会话公网传输慢；
// 改分页后每页只回 limit 条，前端据 hasMore/nextBefore 续拉更早的历史。
describe('getHistoryPage — 从最近往前分页', () => {
  function seedMessages(sid: string, n: number): void {
    const session = getSession(sid);
    if (!session) throw new Error('session not found');
    for (let i = 0; i < n; i++) {
      session.messages.push({ type: 'claude_json', data: { idx: i } });
    }
  }
  const idxOf = (m: { data?: unknown }): number =>
    (m.data as { idx: number }).idx;

  it('首页(before省略) + 总数 ≤ limit：全部返回，hasMore=false', () => {
    const sid = newSession();
    seedMessages(sid, 5);
    const p = getHistoryPage(sid); // 默认 limit=HISTORY_PAGE_SIZE(50)
    expect(p.messages).toHaveLength(5);
    expect(p.messages.map(idxOf)).toEqual([0, 1, 2, 3, 4]);
    expect(p.hasMore).toBe(false);
    expect(p.nextBefore).toBeUndefined();
  });

  it('总数 > limit：首页只回最近 limit 条 + hasMore=true + nextBefore=本页起始', () => {
    const sid = newSession();
    seedMessages(sid, 7);
    const p = getHistoryPage(sid, 3); // 末尾 3 条 [4,7)
    expect(p.messages.map(idxOf)).toEqual([4, 5, 6]);
    expect(p.hasMore).toBe(true);
    expect(p.nextBefore).toBe(4);
  });

  it('续页(before=nextBefore)：取更早的一页', () => {
    const sid = newSession();
    seedMessages(sid, 7);
    const p = getHistoryPage(sid, 3, 4); // [1,4)
    expect(p.messages.map(idxOf)).toEqual([1, 2, 3]);
    expect(p.hasMore).toBe(true);
    expect(p.nextBefore).toBe(1);
  });

  it('末页：剩余不足 limit 条，hasMore=false + nextBefore=undefined', () => {
    const sid = newSession();
    seedMessages(sid, 7);
    const p = getHistoryPage(sid, 3, 1); // [0,1) 只剩 1 条
    expect(p.messages.map(idxOf)).toEqual([0]);
    expect(p.hasMore).toBe(false);
    expect(p.nextBefore).toBeUndefined();
  });

  it('空会话：首页返回空 + hasMore=false', () => {
    const sid = newSession();
    const p = getHistoryPage(sid);
    expect(p.messages).toEqual([]);
    expect(p.hasMore).toBe(false);
  });

  it('before 越界(>total)：clamp 到 total，不返回空页', () => {
    const sid = newSession();
    seedMessages(sid, 3);
    const p = getHistoryPage(sid, 5, 100); // end clamp 到 3 → [0,3) 全部
    expect(p.messages.map(idxOf)).toEqual([0, 1, 2]);
    expect(p.hasMore).toBe(false);
  });
});
