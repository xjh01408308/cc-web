import { useState, useCallback, useRef } from "react";
import type { AllMessage, ChatMessage } from "../types";
import type { TaskProgress, PermissionDenial, TokenUsage } from "../ws/dispatcher";

// 当前对话流域：消息列表 / 流式加载 / 模型 / 权限模式 / token 用量 / 任务进度 / 权限拒绝。
// 与 useSession（会话实体 CRUD）分开 —— Session 是会话实体 CRUD，Chat 是当前对话流；
// 高耦合通过协调层解（见 ADR 0002）。
//
// resetForSessionChange 暴露给协调层，切换会话/节点时由协调层显式调用，
// 与 session 域 action 组合完成 "select = session.xxx + chat.resetForSessionChange"
// （ADR 0002 L28）。dispatcher.handleSessionInfo 的 creatingNewSession 分支保留散
// setter 走 DispatchContext —— 两处语义同源的 drift，ADR 0002 明确接受。
export function useChat() {
  const [messages, setMessages] = useState<AllMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [model, setModel] = useState("");
  const [hasReceivedInit, setHasReceivedInit] = useState(false);
  const [permissionMode, setPermissionMode] = useState<string>("");
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);
  const [permissionDenials, setPermissionDenials] = useState<PermissionDenial[] | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);

  // 流式聚合：跨消息累积当前 assistant 消息（增量更新）。
  // dispatcher 与协调层 handleAbort 直接读写 .current。
  const currentAssistantMessageRef = useRef<ChatMessage | null>(null);

  // 切换会话/节点时重置 chat 域 state（7 个）。
  // 不含 isLoading —— 原 handleSelectNode/handleSelectSession 也不重置
  // （isLoading 由 send / streaming done 控制，非会话切换语义）。
  const resetForSessionChange = useCallback(() => {
    setMessages([]);
    setHasReceivedInit(false);
    setTokenUsage(null);
    setModel("");
    setPermissionMode("");
    setPermissionDenials(null);
    setTaskProgress(null);
  }, []);

  return {
    messages,
    setMessages,
    isLoading,
    setIsLoading,
    model,
    setModel,
    hasReceivedInit,
    setHasReceivedInit,
    permissionMode,
    setPermissionMode,
    taskProgress,
    setTaskProgress,
    permissionDenials,
    setPermissionDenials,
    tokenUsage,
    setTokenUsage,
    currentAssistantMessageRef,
    resetForSessionChange,
  };
}
