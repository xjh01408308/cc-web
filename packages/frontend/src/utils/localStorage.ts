// localStorage 持久化辅助：最后浏览态。
// 纯函数，dispatcher 与 ChatView 直接 import（非 hook、非 DI）。

const LAST_VIEW_KEY = "cc-web-last-view";

export interface LastView {
  nodeId?: string;
  projectId?: string;
  sessionId?: string;
  projectPath?: string;
  projectName?: string;
}

// 持久化最后浏览状态（含 projectPath，避免重启后路径依赖 process.cwd()）
export function saveLastView(
  nodeId: string,
  projectId?: string | null,
  sessionId?: string | null,
  projectPath?: string | null,
  projectName?: string | null,
): void {
  try {
    localStorage.setItem(
      LAST_VIEW_KEY,
      JSON.stringify({
        nodeId,
        projectId: projectId || undefined,
        sessionId: sessionId || undefined,
        projectPath: projectPath || undefined,
        projectName: projectName || undefined,
      }),
    );
  } catch {
    /* localStorage 不可用 */
  }
}

export function loadLastView(): LastView | null {
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
