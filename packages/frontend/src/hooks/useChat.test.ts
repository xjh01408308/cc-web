// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ChatMessage } from "../types";
import type { TaskProgress, PermissionDenial, TokenUsage } from "../ws/dispatcher";
import { useChat } from "./useChat";

const sampleMessage: ChatMessage = {
  type: "chat",
  role: "user",
  content: "hi",
  timestamp: 1,
};

const sampleTaskProgress: TaskProgress = {
  description: "doing",
  totalTokens: 100,
  toolUses: 5,
  durationMs: 2000,
  lastToolName: "Bash",
};

const samplePermissionDenials: PermissionDenial[] = [
  { tool_name: "Bash", tool_use_id: "tu_1", tool_input: { cmd: "rm" } },
];

const sampleTokenUsage: TokenUsage = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheCreationTokens: 3,
  costUSD: 0.001,
  contextWindow: 200000,
  compactionVersion: 2,
};

describe("useChat — resetForSessionChange", () => {
  it("重置 messages/hasReceivedInit/tokenUsage/model/permissionMode/permissionDenials/taskProgress 到初始值", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.setMessages([sampleMessage]);
      result.current.setHasReceivedInit(true);
      result.current.setTokenUsage(sampleTokenUsage);
      result.current.setModel("claude-opus-4-5");
      result.current.setPermissionMode("bypassPermissions");
      result.current.setPermissionDenials(samplePermissionDenials);
      result.current.setTaskProgress(sampleTaskProgress);
    });

    act(() => result.current.resetForSessionChange());

    expect(result.current.messages).toEqual([]);
    expect(result.current.hasReceivedInit).toBe(false);
    expect(result.current.tokenUsage).toBeNull();
    expect(result.current.model).toBe("");
    expect(result.current.permissionMode).toBe("");
    expect(result.current.permissionDenials).toBeNull();
    expect(result.current.taskProgress).toBeNull();
  });

  it("不重置 isLoading（原 handleSelectNode/handleSelectSession 也不重置 —— behavior-preserving）", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.setIsLoading(true));
    act(() => result.current.resetForSessionChange());
    expect(result.current.isLoading).toBe(true);
  });
});
