import { Component, type ErrorInfo, type ReactNode } from "react";

// 顶层错误边界：捕获子树渲染期未预期错误，避免整页白屏。
// 只兜底渲染错误（事件回调 / 异步 / setTimeout 中的错误仍需各自 try-catch）。
// fallback 给出错误摘要 + 整页刷新入口；不清 localStorage（避免误删用户正常数据）。
class ErrorBoundary extends Component<{ children: ReactNode }, { message: string }> {
  state = { message: "" };

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] 未捕获的渲染错误:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children;
    return (
      <div className="flex h-dvh items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
        <div className="w-full max-w-md text-center">
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-2">页面渲染出错</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">已捕获未预期的错误，避免整页白屏。</p>
          <pre className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 rounded p-3 mb-4 overflow-auto max-h-40 text-left whitespace-pre-wrap break-all">
            {this.state.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
