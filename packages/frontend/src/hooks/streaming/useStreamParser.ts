import { useCallback, useMemo } from "react";
import type {
  StreamResponse,
  SDKMessage,
  SystemMessage,
  AbortMessage,
  AllMessage,
  ChatMessage,
} from "../../types";
import {
  isSystemMessage,
  isAssistantMessage,
  isResultMessage,
  isUserMessage,
} from "../../utils/messageTypes";
import {
  UnifiedMessageProcessor,
  type ProcessingContext,
} from "../../utils/UnifiedMessageProcessor";

export interface StreamingContext {
  currentAssistantMessage: ChatMessage | null;
  setCurrentAssistantMessage: (msg: ChatMessage | null) => void;
  addMessage: (msg: AllMessage) => void;
  updateLastMessage: (content: string) => void;
  onSessionId?: (sessionId: string) => void;
  shouldShowInitMessage?: () => boolean;
  onInitMessageShown?: () => void;
  hasReceivedInit?: boolean;
  setHasReceivedInit?: (received: boolean) => void;
  onPermissionError?: (
    toolName: string,
    patterns: string[],
    toolUseId: string,
  ) => void;
  onAbortRequest?: () => void;
  onTokenUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUSD: number;
    contextWindow: number;
  }) => void;
  onPermissionDenied?: (denials: Array<{
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  }>) => void;
  onTaskProgress?: (progress: {
    description: string;
    totalTokens: number;
    toolUses: number;
    durationMs: number;
    lastToolName: string;
  }) => void;
  onModel?: (model: string) => void;
}

export function useStreamParser() {
  // Create a single unified processor instance
  const processor = useMemo(() => new UnifiedMessageProcessor(), []);

  // Convert StreamingContext to ProcessingContext
  const adaptContext = useCallback(
    (context: StreamingContext): ProcessingContext => {
      return {
        // Core message handling
        addMessage: context.addMessage,
        updateLastMessage: context.updateLastMessage,

        // Current assistant message state
        currentAssistantMessage: context.currentAssistantMessage,
        setCurrentAssistantMessage: context.setCurrentAssistantMessage,

        // Session handling
        onSessionId: context.onSessionId,
        hasReceivedInit: context.hasReceivedInit,
        setHasReceivedInit: context.setHasReceivedInit,

        // Init message handling
        shouldShowInitMessage: context.shouldShowInitMessage,
        onInitMessageShown: context.onInitMessageShown,

        // Permission/Error handling
        onPermissionError: context.onPermissionError,
        onAbortRequest: context.onAbortRequest,
        onPermissionDenied: context.onPermissionDenied,
        onTaskProgress: context.onTaskProgress,
      };
    },
    [],
  );

  const processClaudeData = useCallback(
    (claudeData: SDKMessage, context: StreamingContext) => {
      const processingContext = adaptContext(context);

      // Validate message types before processing
      switch (claudeData.type) {
        case "system": {
          if (!isSystemMessage(claudeData)) {
            console.warn("Invalid system message:", claudeData);
            return;
          }
          if (claudeData.subtype === "init" && claudeData.model) {
            context.onModel?.(claudeData.model);
          }
          if ((claudeData as Record<string, unknown>).subtype === "task_progress" && (claudeData as Record<string, unknown>).usage && (claudeData as Record<string, unknown>).last_tool_name) {
            const t = claudeData as Record<string, unknown>;
            context.onTaskProgress?.({
              description: (t.description as string) || "",
              totalTokens: (t.usage as Record<string, number>).total_tokens || 0,
              toolUses: (t.usage as Record<string, number>).tool_uses || 0,
              durationMs: (t.usage as Record<string, number>).duration_ms || 0,
              lastToolName: t.last_tool_name as string,
            });
          }
          break;
        }
        case "assistant":
          if (!isAssistantMessage(claudeData)) {
            console.warn("Invalid assistant message:", claudeData);
            return;
          }
          break;
        case "result": {
          if (!isResultMessage(claudeData)) {
            console.warn("Invalid result message:", claudeData);
            return;
          }
          // 提取 token 用量和上下文窗口
          if (claudeData.usage) {
            const u = claudeData.usage;
            // 从 modelUsage 提取 contextWindow（取所有模型中的最大值）
            let contextWindow = 0;
            const modelUsage = claudeData.modelUsage;
            if (modelUsage) {
              for (const m of Object.values(modelUsage)) {
                const w = m.contextWindow || 0;
                if (w > contextWindow) contextWindow = w;
              }
            }
            context.onTokenUsage?.({
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              cacheReadTokens: u.cache_read_input_tokens || 0,
              cacheCreationTokens: u.cache_creation_input_tokens || 0,
              costUSD: claudeData.total_cost_usd || 0,
              contextWindow,
            });
          }
          break;
        }
        case "user":
          if (!isUserMessage(claudeData)) {
            console.warn("Invalid user message:", claudeData);
            return;
          }
          break;
        default:
          console.log("Unknown Claude message type:", claudeData);
          return;
      }

      // Process the message using the unified processor
      processor.processMessage(claudeData, processingContext, {
        isStreaming: true,
      });
    },
    [processor, adaptContext],
  );

  const processStreamLine = useCallback(
    (line: string, context: StreamingContext) => {
      try {
        const data: StreamResponse = JSON.parse(line);

        if (data.type === "claude_json" && data.data) {
          // data.data is already an SDKMessage object, no need to parse
          const claudeData = data.data as SDKMessage;
          processClaudeData(claudeData, context);
        } else if (data.type === "error") {
          const errorMessage: SystemMessage = {
            type: "error",
            subtype: "stream_error",
            message: data.error || "Unknown error",
            timestamp: Date.now(),
          };
          context.addMessage(errorMessage);
        } else if (data.type === "aborted") {
          const abortedMessage: AbortMessage = {
            type: "system",
            subtype: "abort",
            message: "Operation was aborted by user",
            timestamp: Date.now(),
          };
          context.addMessage(abortedMessage);
          context.setCurrentAssistantMessage(null);
        }
      } catch (parseError) {
        console.error("Failed to parse stream line:", parseError);
      }
    },
    [processClaudeData],
  );

  return {
    processStreamLine,
  };
}
