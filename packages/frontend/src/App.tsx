import { ChatView } from "./components/ChatView";
import { AdminView } from "./components/AdminView";

// 极简 pathname 路由（issue #22 骨架）：/admin → 管理视图，其余 → 聊天主视图。
// 导航经 <a href> 整页跳转，故无需 client-side 路由状态；relay serveStatic 对 /admin 做 SPA fallback 回 index.html。
// 后续 Node 管理 / Assignment 授权在此追加分支即可复用同一守卫模式。
function App() {
  if (window.location.pathname === "/admin") {
    return <AdminView />;
  }
  return (
    <div className="h-dvh bg-slate-50 dark:bg-slate-900 transition-colors duration-300 flex flex-col">
      <div className="flex-1 min-h-0 bg-white/70 dark:bg-slate-800/70 border border-slate-200/60 dark:border-slate-700/60 shadow-sm backdrop-blur-sm overflow-hidden">
        <ChatView />
      </div>
    </div>
  );
}

export default App;
