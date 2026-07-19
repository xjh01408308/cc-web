import type { AllMessage } from "../types";

// 去重：result 消息的文本与它前面的 assistant 消息相同，批量加载时会产生重复。
// 从 ChatView 提取为共享纯函数，供 WS dispatcher 与初始加载路径复用。
export function dedupConsecutiveAssistant(messages: AllMessage[]): AllMessage[] {
  const result: AllMessage[] = [];
  for (const msg of messages) {
    if (msg.type === "chat" && msg.role === "assistant") {
      const prev = result[result.length - 1];
      if (
        prev &&
        prev.type === "chat" &&
        prev.role === "assistant" &&
        prev.content === msg.content
      ) {
        continue;
      }
    }
    result.push(msg);
  }
  return result;
}
