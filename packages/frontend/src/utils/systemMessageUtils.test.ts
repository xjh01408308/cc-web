import { describe, it, expect } from "vitest";
import {
  createSystemMessageView,
  formatDetailLines,
  type DetailLine,
} from "./systemMessageUtils";
import type { SystemMessage } from "../types";

// SDK 消息字段多，测试只关心 presenter 读取的字段；用 cast 绕开完整 union
// （同 dispatcher.test.ts 的 ev() 风格）。
function initMsg(overrides: Record<string, unknown> = {}): SystemMessage {
  return {
    type: "system",
    subtype: "init",
    model: "claude-sonnet-5",
    session_id: "abc123def456",
    tools: [{ name: "Read" }, { name: "Edit" }, { name: "Bash" }],
    cwd: "/home/user/project",
    permissionMode: "default",
    apiKeySource: "oauth",
    timestamp: 0,
    ...overrides,
  } as unknown as SystemMessage;
}

function resultMsg(overrides: Record<string, unknown> = {}): SystemMessage {
  return {
    type: "result",
    duration_ms: 12345,
    total_cost_usd: 0.123456,
    usage: { input_tokens: 100, output_tokens: 200 },
    timestamp: 0,
    ...overrides,
  } as unknown as SystemMessage;
}

function linesAsMap(view: { details: { kind: string; lines?: DetailLine[] } }) {
  if (view.details.kind !== "lines" || !view.details.lines) {
    throw new Error("expected lines view");
  }
  return Object.fromEntries(view.details.lines.map((l) => [l.label, l.value])) as Record<
    string,
    string
  >;
}

describe("createSystemMessageView — init", () => {
  it("returns lines view with 6 label/value pairs and System/init badge", () => {
    const view = createSystemMessageView(initMsg());
    expect(view.label).toBe("System");
    expect(view.badge).toBe("init");
    expect(view.details.kind).toBe("lines");

    const m = linesAsMap(view);
    expect(m["Model"]).toBe("claude-sonnet-5");
    expect(m["Session"]).toBe("abc123de");
    expect(m["Tools"]).toBe("3 available");
    expect(m["CWD"]).toBe("/home/user/project");
    expect(m["Permission Mode"]).toBe("default");
    expect(m["API Key Source"]).toBe("oauth");
  });

  it("truncates session_id to SESSION_ID_DISPLAY_LENGTH (8)", () => {
    const view = createSystemMessageView(initMsg({ session_id: "abcdefghijklmnop" }));
    expect(linesAsMap(view)["Session"]).toBe("abcdefgh");
  });

  it("renders permissionMode as-is (bypassPermissions → bypassPermissions)", () => {
    const view = createSystemMessageView(initMsg({ permissionMode: "bypassPermissions" }));
    expect(linesAsMap(view)["Permission Mode"]).toBe("bypassPermissions");
  });
});

describe("createSystemMessageView — result", () => {
  it("returns lines view with duration/cost/tokens and Result label", () => {
    const view = createSystemMessageView(resultMsg());
    expect(view.label).toBe("Result");
    expect(view.details.kind).toBe("lines");

    const m = linesAsMap(view);
    expect(m["Duration"]).toBe("12345ms");
    expect(m["Cost"]).toBe("$0.1235"); // toFixed(4)
    expect(m["Tokens"]).toBe("100 in, 200 out");
  });
});

describe("createSystemMessageView — error", () => {
  it("returns raw view with message content and Error label", () => {
    const msg = {
      type: "error",
      subtype: "stream_error",
      message: "boom",
      timestamp: 0,
    } as unknown as SystemMessage;
    const view = createSystemMessageView(msg);
    expect(view.label).toBe("Error");
    expect(view.details).toEqual({ kind: "raw", content: "boom" });
  });
});

describe("createSystemMessageView — hooks", () => {
  it("returns raw view with ANSI sequences stripped, no badge", () => {
    const ESC = String.fromCharCode(27);
    const content = `${ESC}[32mhello${ESC}[0m world`;
    const msg = { type: "system", content, timestamp: 0 } as unknown as SystemMessage;
    const view = createSystemMessageView(msg);
    expect(view.label).toBe("System");
    expect(view.badge).toBeUndefined();
    expect(view.details).toEqual({ kind: "raw", content: "hello world" });
  });
});

describe("createSystemMessageView — fallback (unhandled system msg, e.g. abort)", () => {
  it("returns raw view with JSON.stringify and System label + abort badge", () => {
    const msg = {
      type: "system",
      subtype: "abort",
      message: "stopped",
      timestamp: 0,
    } as unknown as SystemMessage;
    const view = createSystemMessageView(msg);
    expect(view.label).toBe("System");
    expect(view.badge).toBe("abort");
    expect(view.details.kind).toBe("raw");
    if (view.details.kind !== "raw") throw new Error("expected raw");
    expect(view.details.content).toContain('"subtype": "abort"');
  });
});

describe("formatDetailLines", () => {
  it("joins label:value pairs with newline", () => {
    const lines: DetailLine[] = [
      { label: "Model", value: "x" },
      { label: "Tools", value: "5 available" },
    ];
    expect(formatDetailLines(lines)).toBe("Model: x\nTools: 5 available");
  });

  it("returns empty string for empty array", () => {
    expect(formatDetailLines([])).toBe("");
  });
});
