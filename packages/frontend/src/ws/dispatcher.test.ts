import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchBrowserEvent } from "./dispatcher";
import type { DispatchContext } from "./dispatcher";
import { BrowserEventType } from "../types";
import type { BrowserEvent } from "../types";
import { loadLastView, removeNodePassword } from "../utils/localStorage";

// dispatcher 直接 import localStorage utils（非 ctx 注入），故 mock 模块。
vi.mock("../utils/localStorage", () => ({
  loadLastView: vi.fn(),
  removeNodePassword: vi.fn(),
}));

// ---- mock context 工厂 ----

// 注意：不显式标注返回类型，且 overrides 用宽 object 类型 —— 让 setter 推断为
// vi.fn() 的 Mock 类型（测试可访问 .mock）；调用 dispatchBrowserEvent 时 TS 仍验证
// ctx 满足 DispatchContext（Mock 兼容 Dispatch、ref 类型一致）。
function createMockContext(overrides: object = {}) {
  return {
    activeNodeId: null,
    activeSessionId: null,
    processStreamLine: vi.fn(),
    hasReceivedInit: false,
    currentAssistantMessageRef: { current: null },
    pendingSessionRef: { current: null },
    creatingNewSessionRef: { current: false },
    autoAuthTimeoutRef: { current: null },
    setNodes: vi.fn(),
    setActiveNodeId: vi.fn(),
    setAuthenticatedNodes: vi.fn(),
    setPendingAuthNodeId: vi.fn(),
    setAuthError: vi.fn(),
    setAutoAuthInProgress: vi.fn(),
    setProjects: vi.fn(),
    setSessions: vi.fn(),
    setActiveSessionId: vi.fn(),
    setActiveProjectId: vi.fn(),
    setMessages: vi.fn(),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    setHasReceivedInit: vi.fn(),
    setIsLoading: vi.fn(),
    setTaskProgress: vi.fn(),
    setPermissionDenials: vi.fn(),
    setTokenUsage: vi.fn(),
    setGitStatuses: vi.fn(),
    setDiffState: vi.fn(),
    setFileTrees: vi.fn(),
    setFileTreeErrors: vi.fn(),
    setFileTreeLoading: vi.fn(),
    setFileViewState: vi.fn(),
    ...overrides,
  };
}

// 用 any 构造事件，避免每个测试手写完整 union 字段；type 字段由测试明确指定。
function ev(partial: Record<string, unknown>): BrowserEvent {
  return partial as unknown as BrowserEvent;
}

// loadLastView / removeNodePassword 是模块级单例 mock，每个测试前重置调用与实现。
beforeEach(() => {
  vi.mocked(loadLastView).mockReset();
  vi.mocked(loadLastView).mockReturnValue(null);
  vi.mocked(removeNodePassword).mockReset();
});

describe("dispatchBrowserEvent — nodeId 过滤", () => {
  it("早期类型（NodesList）不经 nodeId 过滤", () => {
    const ctx = createMockContext({ activeNodeId: "node-A" });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.NodesList, nodes: [] }),
      ctx,
    );
    expect(ctx.setNodes).toHaveBeenCalledWith([]);
  });

  it("附带 nodeId 与 activeNodeId 不匹配 → 跳过", () => {
    const ctx = createMockContext({ activeNodeId: "node-A" });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ProjectsList, projects: [], nodeId: "node-B" }),
      ctx,
    );
    expect(ctx.setProjects).not.toHaveBeenCalled();
  });

  it("附带 nodeId 与 activeNodeId 匹配 → 处理", () => {
    const ctx = createMockContext({ activeNodeId: "node-A" });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ProjectsList, projects: [], nodeId: "node-A" }),
      ctx,
    );
    expect(ctx.setProjects).toHaveBeenCalledWith([]);
  });

  it("activeNodeId 为 null → 不过滤（全收）", () => {
    const ctx = createMockContext({ activeNodeId: null });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ProjectsList, projects: [], nodeId: "node-B" }),
      ctx,
    );
    expect(ctx.setProjects).toHaveBeenCalledWith([]);
  });
});

describe("dispatchBrowserEvent — NodesList", () => {
  it("单节点 → setActiveNodeId(prev => prev || id)", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.NodesList, nodes: [{ nodeId: "n1" }] }),
      ctx,
    );
    expect(ctx.setNodes).toHaveBeenCalledWith([{ nodeId: "n1" }]);
    expect(ctx.setActiveNodeId).toHaveBeenCalledTimes(1);
    const updater = ctx.setActiveNodeId.mock.calls[0][0] as (
      prev: string | null,
    ) => string | null;
    expect(updater(null)).toBe("n1");
    expect(updater("existing")).toBe("existing");
  });

  it("零节点 → setActiveNodeId(null)", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(ev({ type: BrowserEventType.NodesList, nodes: [] }), ctx);
    expect(ctx.setActiveNodeId).toHaveBeenCalledWith(null);
  });

  it("多节点 → 不调 setActiveNodeId", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.NodesList, nodes: [{ nodeId: "n1" }, { nodeId: "n2" }] }),
      ctx,
    );
    expect(ctx.setActiveNodeId).not.toHaveBeenCalled();
  });

  it("nodes 缺失 → no-op", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(ev({ type: BrowserEventType.NodesList }), ctx);
    expect(ctx.setNodes).not.toHaveBeenCalled();
  });
});

describe("dispatchBrowserEvent — AuthResult", () => {
  it("成功 → 加入 authenticatedNodes、清 pending、从 loadLastView 恢复 pendingSession", () => {
    vi.mocked(loadLastView).mockReturnValue({ nodeId: "n1", sessionId: "sess-9" });
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.AuthResult, nodeId: "n1", success: true }),
      ctx,
    );
    expect(ctx.setAuthenticatedNodes).toHaveBeenCalledTimes(1);
    const updater = ctx.setAuthenticatedNodes.mock.calls[0][0] as (
      prev: Set<string>,
    ) => Set<string>;
    expect(updater(new Set()).has("n1")).toBe(true);
    expect(ctx.setPendingAuthNodeId).toHaveBeenCalledWith(null);
    expect(ctx.setAuthError).toHaveBeenCalledWith(null);
    expect(ctx.setAutoAuthInProgress).toHaveBeenCalledWith(false);
    expect(ctx.pendingSessionRef.current).toBe("sess-9");
  });

  it("成功 + pendingSession 已设 → 不覆盖", () => {
    const ctx = createMockContext({
      pendingSessionRef: { current: "existing" },
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.AuthResult, nodeId: "n1", success: true }),
      ctx,
    );
    expect(ctx.pendingSessionRef.current).toBe("existing");
    expect(loadLastView).not.toHaveBeenCalled();
  });

  it("密码错误 → 移除保存密码、设置错误", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.AuthResult, nodeId: "n1", success: false, error: "密码错误" }),
      ctx,
    );
    expect(removeNodePassword).toHaveBeenCalledWith("n1");
    expect(ctx.setAuthError).toHaveBeenCalledWith("密码错误");
    expect(ctx.setAutoAuthInProgress).toHaveBeenCalledWith(false);
  });

  it("认证超时 → 不移除保存密码（链路瞬时问题非密码错），仍设置错误", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.AuthResult, nodeId: "n1", success: false, error: "认证超时" }),
      ctx,
    );
    expect(removeNodePassword).not.toHaveBeenCalled();
    expect(ctx.setAuthError).toHaveBeenCalledWith("认证超时");
    expect(ctx.setAutoAuthInProgress).toHaveBeenCalledWith(false);
  });

  it("失败 + 无 error → 默认错误文案", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.AuthResult, nodeId: "n1", success: false }),
      ctx,
    );
    expect(ctx.setAuthError).toHaveBeenCalledWith("认证失败");
  });

  it("成功 + 有 timeout 句柄 → 清除", () => {
    const handle = setTimeout(() => {}, 10000);
    const ctx = createMockContext({
      autoAuthTimeoutRef: { current: handle },
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.AuthResult, nodeId: "n1", success: true }),
      ctx,
    );
    expect(ctx.autoAuthTimeoutRef.current).toBeNull();
    clearTimeout(handle);
  });
});

describe("dispatchBrowserEvent — AuthRequired", () => {
  it("设置 pendingAuthNodeId、停止 loading", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.AuthRequired, nodeId: "n1", message: "need pw" }),
      ctx,
    );
    expect(ctx.setPendingAuthNodeId).toHaveBeenCalledWith("n1");
    expect(ctx.setIsLoading).toHaveBeenCalledWith(false);
    expect(ctx.setTaskProgress).toHaveBeenCalledWith(null);
  });

  it("无 nodeId → no-op", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(ev({ type: BrowserEventType.AuthRequired }), ctx);
    expect(ctx.setPendingAuthNodeId).not.toHaveBeenCalled();
  });
});

describe("dispatchBrowserEvent — ProjectsList / ProjectInfo", () => {
  it("ProjectsList → setProjects", () => {
    const ctx = createMockContext();
    const projects = [{ projectId: "p1", name: "P1", path: "/p1" }];
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ProjectsList, projects }),
      ctx,
    );
    expect(ctx.setProjects).toHaveBeenCalledWith(projects);
  });

  it("ProjectInfo 新增", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ProjectInfo, project: { projectId: "p1", name: "P1", path: "/p1" } }),
      ctx,
    );
    const updater = ctx.setProjects.mock.calls[0][0] as (
      prev: { projectId: string }[],
    ) => { projectId: string }[];
    expect(updater([])).toHaveLength(1);
  });

  it("ProjectInfo 已存在 → 更新", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ProjectInfo, project: { projectId: "p1", name: "new", path: "/p1" } }),
      ctx,
    );
    const updater = ctx.setProjects.mock.calls[0][0] as (prev: unknown[]) => unknown[];
    const result = updater([{ projectId: "p1", name: "old", path: "/p1" }]);
    expect(result).toHaveLength(1);
    expect((result[0] as { name: string }).name).toBe("new");
  });
});

describe("dispatchBrowserEvent — SessionInfo", () => {
  it("creatingNewSession → 选中新会话并重置聊天态", () => {
    const ctx = createMockContext({
      creatingNewSessionRef: { current: true },
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.SessionInfo, sessionId: "s1", projectId: "p1", model: "m" }),
      ctx,
    );
    expect(ctx.creatingNewSessionRef.current).toBe(false);
    expect(ctx.setActiveSessionId).toHaveBeenCalledWith("s1");
    expect(ctx.setActiveProjectId).toHaveBeenCalledWith("p1");
    expect(ctx.pendingSessionRef.current).toBe("s1");
    expect(ctx.setMessages).toHaveBeenCalledWith([]);
    expect(ctx.setHasReceivedInit).toHaveBeenCalledWith(false);
    expect(ctx.setTokenUsage).toHaveBeenCalledWith(null);
    expect(ctx.setModel).toHaveBeenCalledWith("");
    expect(ctx.setPermissionDenials).toHaveBeenCalledWith(null);
    expect(ctx.setTaskProgress).toHaveBeenCalledWith(null);
    expect(ctx.setModel).toHaveBeenCalledWith("m");
  });

  it("auto-select：无活跃会话且无 pending → 选中", () => {
    const ctx = createMockContext({
      activeSessionId: null,
      pendingSessionRef: { current: null },
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.SessionInfo, sessionId: "s1", projectId: "p1" }),
      ctx,
    );
    expect(ctx.setActiveSessionId).toHaveBeenCalledWith("s1");
    expect(ctx.pendingSessionRef.current).toBe("s1");
  });

  it("已有活跃会话 → 不自动选中", () => {
    const ctx = createMockContext({
      activeSessionId: "existing",
      pendingSessionRef: { current: null },
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.SessionInfo, sessionId: "s1", projectId: "p1" }),
      ctx,
    );
    expect(ctx.setActiveSessionId).not.toHaveBeenCalled();
  });
});

describe("dispatchBrowserEvent — SessionsList", () => {
  it("无 pendingSession → 只 setSessions", () => {
    const ctx = createMockContext({ pendingSessionRef: { current: null } });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.SessionsList, sessions: [] }),
      ctx,
    );
    expect(ctx.setSessions).toHaveBeenCalledWith([]);
    expect(ctx.setActiveSessionId).not.toHaveBeenCalled();
  });

  it("pending 不匹配 → 不加载历史", () => {
    const ctx = createMockContext({ pendingSessionRef: { current: "missing" } });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.SessionsList, sessions: [{ sessionId: "other" }] }),
      ctx,
    );
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });

  it("pending 匹配 + 无 active → 恢复会话状态", () => {
    const ctx = createMockContext({
      pendingSessionRef: { current: "s1" },
    });
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.SessionsList,
        sessions: [{ sessionId: "s1", projectId: "p1", model: "m", permissionMode: "acceptEdits" }],
      }),
      ctx,
    );
    expect(ctx.setActiveSessionId).toHaveBeenCalledWith("s1");
    expect(ctx.setActiveProjectId).toHaveBeenCalledWith("p1");
    expect(ctx.setModel).toHaveBeenCalledWith("m");
    expect(ctx.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
  });

  it("pending 匹配 + 有 active → 不恢复 active", () => {
    const ctx = createMockContext({
      pendingSessionRef: { current: "s1" },
      activeSessionId: "existing",
    });
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.SessionsList,
        sessions: [{ sessionId: "s1", projectId: "p1" }],
      }),
      ctx,
    );
    expect(ctx.setActiveSessionId).not.toHaveBeenCalled();
    expect(ctx.setActiveProjectId).not.toHaveBeenCalled();
  });

  it("pending 匹配 + 有 active + target 带 model/permissionMode → 仍更新二者（切换会话）", () => {
    const ctx = createMockContext({
      pendingSessionRef: { current: "s1" },
      activeSessionId: "existing",
    });
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.SessionsList,
        sessions: [{ sessionId: "s1", projectId: "p1", model: "m", permissionMode: "bypassPermissions" }],
      }),
      ctx,
    );
    // active 不被覆盖
    expect(ctx.setActiveSessionId).not.toHaveBeenCalled();
    // 但 model/permissionMode 要更新（切换会话场景）
    expect(ctx.setModel).toHaveBeenCalledWith("m");
    expect(ctx.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
  });

  it("pending 匹配 + 有 messages → 加载历史 + setHasReceivedInit(true)", () => {
    const ctx = createMockContext({
      pendingSessionRef: { current: "s1" },
      activeSessionId: "s1",
    });
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.SessionsList,
        sessions: [
          {
            sessionId: "s1",
            messages: [
              {
                type: "claude_json",
                data: { type: "user", message: { role: "user", content: "hi" } },
              },
            ],
          },
        ],
      }),
      ctx,
    );
    expect(ctx.setMessages).toHaveBeenCalledTimes(1);
    expect(ctx.setHasReceivedInit).toHaveBeenCalledWith(true);
  });

  it("pending 匹配 + messages 全非 claude_json → 不调 setMessages", () => {
    const ctx = createMockContext({
      pendingSessionRef: { current: "s1" },
      activeSessionId: "s1",
    });
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.SessionsList,
        sessions: [
          { sessionId: "s1", messages: [{ type: "other" }] },
        ],
      }),
      ctx,
    );
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});

describe("dispatchBrowserEvent — git / file", () => {
  it("GitStatus → 按 projectId 存入 map", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.GitStatus,
        gitStatus: { projectId: "p1", files: [] },
      }),
      ctx,
    );
    const updater = ctx.setGitStatuses.mock.calls[0][0] as (
      prev: Map<string, unknown>,
    ) => Map<string, unknown>;
    expect(updater(new Map()).get("p1")).toEqual({ projectId: "p1", files: [] });
  });

  it("GitDiff 无 error → 设置 diffState（含 staged）", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.GitDiff,
        diffResult: { filePath: "a.ts", projectPath: "/p", diff: "diff" },
        staged: true,
      }),
      ctx,
    );
    expect(ctx.setDiffState).toHaveBeenCalledWith({
      filePath: "a.ts",
      projectPath: "/p",
      staged: true,
      diff: "diff",
    });
  });

  it("GitDiff 有 error → 不设 diffState", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.GitDiff,
        diffResult: { filePath: "a.ts", projectPath: "/p", diff: "", error: "boom" },
      }),
      ctx,
    );
    expect(ctx.setDiffState).not.toHaveBeenCalled();
  });

  it("FileTree 正常 → 存 tree、删 error、删 loading", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.FileTree,
        fileTreeResult: { projectId: "p1", tree: [] },
      }),
      ctx,
    );
    expect(ctx.setFileTreeLoading).toHaveBeenCalledTimes(1);
    expect(ctx.setFileTrees).toHaveBeenCalledTimes(1);
    expect(ctx.setFileTreeErrors).toHaveBeenCalledTimes(1);
  });

  it("FileTree 有 error → 存 error", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.FileTree,
        fileTreeResult: { projectId: "p1", tree: [], error: "nope" },
      }),
      ctx,
    );
    const updater = ctx.setFileTreeErrors.mock.calls[0][0] as (
      prev: Map<string, string>,
    ) => Map<string, string>;
    expect(updater(new Map()).get("p1")).toBe("nope");
    expect(ctx.setFileTrees).not.toHaveBeenCalled();
  });

  it("FileContent 无 error → 设置 fileViewState", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.FileContent,
        fileContentResult: {
          filePath: "a.ts",
          projectPath: "/p",
          content: "x",
          mimeType: "code",
          language: "ts",
        },
      }),
      ctx,
    );
    expect(ctx.setFileViewState).toHaveBeenCalledWith({
      filePath: "a.ts",
      projectPath: "/p",
      content: "x",
      mimeType: "code",
      language: "ts",
    });
  });
});

describe("dispatchBrowserEvent — SessionEnd", () => {
  it("停止 loading、清 currentAssistantMessage", () => {
    const ctx = createMockContext({
      currentAssistantMessageRef: { current: { type: "chat", role: "assistant", content: "x", timestamp: 1 } },
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.SessionEnd, sessionId: "s1" }),
      ctx,
    );
    expect(ctx.setIsLoading).toHaveBeenCalledWith(false);
    expect(ctx.currentAssistantMessageRef.current).toBeNull();
  });
});

describe("dispatchBrowserEvent — streaming（ClaudeJson / Error / Done / Aborted）", () => {
  it("无 activeSessionId + 带 sessionId → 自动恢复", () => {
    const ctx = createMockContext({
      processStreamLine: vi.fn(),
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ClaudeJson, sessionId: "streaming-sid", data: { type: "user" } }),
      ctx,
    );
    expect(ctx.setActiveSessionId).toHaveBeenCalledWith("streaming-sid");
  });

  it("有 activeSessionId + 带 sessionId → 不调 setActiveSessionId", () => {
    const ctx = createMockContext({
      activeSessionId: "existing",
      processStreamLine: vi.fn(),
    });
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ClaudeJson, sessionId: "streaming-sid", data: { type: "user" } }),
      ctx,
    );
    expect(ctx.setActiveSessionId).not.toHaveBeenCalled();
  });

  it("调用 processStreamLine，传入 JSON.stringify(event)", () => {
    const processStreamLine = vi.fn();
    const ctx = createMockContext({ processStreamLine });
    const event = ev({ type: BrowserEventType.Done, sessionId: "s1" });
    dispatchBrowserEvent(event, ctx);
    expect(processStreamLine).toHaveBeenCalledTimes(1);
    const [line, streamingCtx] = processStreamLine.mock.calls[0];
    expect(line).toBe(JSON.stringify(event));
    // streamingContext 应携带 hasReceivedInit / 关键回调
    expect(streamingCtx.hasReceivedInit).toBe(false);
    expect(typeof streamingCtx.addMessage).toBe("function");
    expect(typeof streamingCtx.onTokenUsage).toBe("function");
  });

  it("ClaudeJson init → setModel", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.ClaudeJson,
        sessionId: "s1",
        data: { type: "system", subtype: "init", model: "claude-x" },
      }),
      ctx,
    );
    expect(ctx.setModel).toHaveBeenCalledWith("claude-x");
  });

  it("ClaudeJson compact_boundary + 已有 tokenUsage → 校准 + compactionVersion++", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.ClaudeJson,
        sessionId: "s1",
        data: {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { pre_tokens: 5000 },
        },
      }),
      ctx,
    );
    const updater = ctx.setTokenUsage.mock.calls[0][0] as (prev: unknown) => unknown;
    const result = updater({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheCreationTokens: 20,
      costUSD: 0.1,
      contextWindow: 200000,
      compactionVersion: 2,
    }) as {
      inputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      compactionVersion: number;
    };
    expect(result.inputTokens).toBe(5000);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.compactionVersion).toBe(3);
  });

  it("ClaudeJson compact_boundary + 无已有 tokenUsage → null", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({
        type: BrowserEventType.ClaudeJson,
        sessionId: "s1",
        data: {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { pre_tokens: 5000 },
        },
      }),
      ctx,
    );
    const updater = ctx.setTokenUsage.mock.calls[0][0] as (
      prev: unknown,
    ) => unknown;
    expect(updater(null)).toBeNull();
  });

  it("Done → 收尾（停止 loading、清 taskProgress、清 currentAssistantMessage）", () => {
    const ctx = createMockContext({
      currentAssistantMessageRef: { current: { type: "chat", role: "assistant", content: "x", timestamp: 1 } },
    });
    dispatchBrowserEvent(ev({ type: BrowserEventType.Done, sessionId: "s1" }), ctx);
    expect(ctx.setIsLoading).toHaveBeenCalledWith(false);
    expect(ctx.setTaskProgress).toHaveBeenCalledWith(null);
    expect(ctx.currentAssistantMessageRef.current).toBeNull();
  });

  it("ClaudeJson（非 Done/Error/Aborted）→ 不收尾", () => {
    const ctx = createMockContext();
    dispatchBrowserEvent(
      ev({ type: BrowserEventType.ClaudeJson, sessionId: "s1", data: { type: "user" } }),
      ctx,
    );
    expect(ctx.setIsLoading).not.toHaveBeenCalled();
    expect(ctx.setTaskProgress).not.toHaveBeenCalled();
  });
});
