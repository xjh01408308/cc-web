---
status: proposed
---

# T-B: ChatView 按域拆 state 到 custom hooks

ChatView（T-A 后 1076 行）持有 30 个 `useState` + 11 个 `useRef`，覆盖浏览器登录、节点认证、项目会话、对话流式、文件浏览多个域。决定按域拆成 6 个 custom hook + 1 个 localStorage utils，ChatView 保留为显式协调层；T-A 抽出的 dispatcher（纯函数）零改动，靠现有 40 测作回归网。

## 域划分

- `useBrowserAuth` / `useNodeAuth` 分开（非合 `useAuth`）：两层认证 state 不共享、handler 不互调，"auth" 是 overloaded 词（见 `CONTEXT.md`）。
- `useSession` / `useChat` 分开（非合）：Session 是会话实体 CRUD，Chat 是当前对话流；高耦合通过协调层解。
- `useFileBrowser` 独立（非提升进 `ProjectSidebar`）：`diffState`/`fileViewState` 还喂 ChatView 级的 `GitDiffModal`/`FileViewerModal`。
- `useUi`：`sidebarOpen` 等 UI 开关（`isMobile` 已独立）。
- `utils/localStorage.ts`（纯函数，非 hook）：dispatcher 直接 import，`DispatchContext` 删 `loadLastView`/`removeNodePassword` 2 字段。

## 共享 ref 归属

`pendingSessionRef` / `creatingNewSessionRef` → `useSession`；`currentAssistantMessageRef` → `useChat`（各自归域，非集中到技术 bridge hook——它们有业务语义）。消除 `activeSessionIdRef`——它是 render 镜像，与 `ctx.activeSessionId` 闭包值经 `handleRawMessageRef` 间接调用同源等价（T-A 标记的历史不一致，T-B 统一）。

## ChatView 协调层（不可消除）

以下留 ChatView，不抽 hook（抽成 `useInitialLoader` / `useDispatcherSubscription` 只是换文件不换本质，且制造隐式握手）：

- `useWebSocket` 单实例持有，`send` / `connected` 参数注入各域 hook（非 context——单层调用，DI 更直接）。
- 初始加载 god effect（跨 nodes → sessions → history 串行编排 + saved view 恢复）。
- dispatcher 订阅链（`handleRawMessage` + `DispatchContext` 30 字段组装 + `onRawMessage`）。
- 跨域协调 handler（select / delete / create session = `session.xxx + chat.resetForSessionChange()`）。

预估 ChatView 拆后 ~450 行。

## dispatcher 边界（T-A 成果不回退）

- `DispatchContext` 形状不变（30 字段平铺，非域 api 对象）——保 40 测全绿作回归网，避免重组 dispatcher ~30 处调用 + 测改写。
- 跨域 reset 两处调用代码（dispatcher.`handleSessionInfo` creatingNewSession 分支走散 setter，ChatView handler 走 `chat.resetForSessionChange`）——接受 drift，因两处调同一组 setter 语义同源；未来若 reset 语义要改，再升级为 ctx 动作字段。

## Considered Options

- 合 `useAuth`：否决，假聚合 + 模糊两层认证。
- 合 `useSessionChat`：否决，接口发散。
- 抽 `useInitialLoader` / `useDispatcherSubscription`：否决，换文件不换本质。
- `useWebSocket` 进 context：否决，单层调用无需新范式。
- `DispatchContext` 重组为域 api 对象（30 字段 → 6 域）：否决，cosmetic 收益不抵 40 测改写。
- dispatcher 按域拆 sub-dispatcher：否决，破坏 T-A 穷尽 union `never` 检查。
- Session hook 注入 Chat reset 回调（`useSession({ onSessionChange })`）：否决，更深耦合伪装成解耦。

## Consequences

- 6 PR 序列：PR-1 `utils/localStorage` → PR-2 消除 `activeSessionIdRef` → PR-3 清 `useClaudeStreaming` Middle Man → PR-4 叶子 hook（`useUi` / `useFileBrowser` / `useBrowserAuth`）→ PR-5 `useNodeAuth` → PR-6 `useSession` + `useChat` + ChatView 协调层（最大，不可再拆）。
- 引入 `@testing-library/react`（`renderHook` 测关键时序：自动认证、WS 重试、流式聚合）；纯函数单测 + 现有 dispatcher 40 测。
- behavior-preserving 靠 `git show HEAD:<path>` 逐行对照 + `/code-review` Spec sub-agent（T-A 教训：AuthNode 超时分支 nodeId 丢失即靠此抓回）。
