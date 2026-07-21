import type { SystemMessage, HooksMessage } from "../types";
import { MESSAGE_CONSTANTS } from "./constants";

// 一个 label:value 行——系统消息里 init/result 的 details 由这种行组成。
export interface DetailLine {
  label: string;
  value: string;
}

// 系统消息的展示视图。init/result 是 label:value 摘要（lines），
// error/hooks/未覆盖分支是原始内容 dump（raw）。
export type SystemMessageDetails =
  | { kind: "lines"; lines: DetailLine[] }
  | { kind: "raw"; content: string };

export interface SystemMessageView {
  label: string;
  badge?: string;
  details: SystemMessageDetails;
}

// ANSI escape sequence regex for cleaning hooks messages
const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// hooks 负载：system 消息 + string content + 无 subtype。
function isHooksMessage(
  msg: SystemMessage,
): msg is HooksMessage & { timestamp: number } {
  return (
    msg.type === "system" &&
    "content" in msg &&
    typeof msg.content === "string" &&
    !("subtype" in msg)
  );
}

export function createSystemMessageView(msg: SystemMessage): SystemMessageView {
  const badge = "subtype" in msg ? msg.subtype : undefined;

  if (
    msg.type === "system" &&
    "subtype" in msg &&
    msg.subtype === "init"
  ) {
    return {
      label: "System",
      badge,
      details: {
        kind: "lines",
        lines: [
          { label: "Model", value: msg.model },
          {
            label: "Session",
            value: msg.session_id.substring(
              0,
              MESSAGE_CONSTANTS.SESSION_ID_DISPLAY_LENGTH,
            ),
          },
          { label: "Tools", value: `${msg.tools.length} available` },
          { label: "CWD", value: msg.cwd },
          {
            label: "Permission Mode",
            value: msg.permissionMode,
          },
          { label: "API Key Source", value: msg.apiKeySource },
        ],
      },
    };
  }

  if (msg.type === "result") {
    return {
      label: "Result",
      badge,
      details: {
        kind: "lines",
        lines: [
          { label: "Duration", value: `${msg.duration_ms}ms` },
          { label: "Cost", value: `$${msg.total_cost_usd.toFixed(4)}` },
          {
            label: "Tokens",
            value: `${msg.usage.input_tokens} in, ${msg.usage.output_tokens} out`,
          },
        ],
      },
    };
  }

  if (msg.type === "error") {
    return { label: "Error", badge, details: { kind: "raw", content: msg.message } };
  }

  if (isHooksMessage(msg)) {
    return {
      label: "System",
      badge,
      details: { kind: "raw", content: msg.content.replace(ANSI_REGEX, "") },
    };
  }

  // 未覆盖分支（如 abort）→ JSON dump 兜底
  return {
    label: msg.type === "system" ? "System" : "Message",
    badge,
    details: { kind: "raw", content: JSON.stringify(msg, null, 2) },
  };
}

export function formatDetailLines(lines: DetailLine[]): string {
  return lines.map((l) => `${l.label}: ${l.value}`).join("\n");
}
