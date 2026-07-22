# cc-web

浏览器远程控制本地 Claude Code，支持一体机、云服务和本地节点三种部署模式。

![演示](images/demo.gif)

## 系统概览

```
浏览器 (React SPA)          中继服务 (ws)             本地节点集群
┌──────────────────┐  wss  ┌──────────────┐  ws   ┌──────────────────┐
│ ChatMessages     │◄─────►│ 静态文件服务  │◄─────►│ 节点 A (开发机)   │
│ MessageComponents│       │ WS 转发/路由  │       │ SessionManager   │
│ useStreamParser  │       │ 会话路由表    │       │ Claude CLI 子进程 │
│ ProjectSidebar   │       │ 节点注册表    │       ├──────────────────┤
│ - 项目下拉选择器  │       │              │  ws   │ 节点 B (笔记本)   │
│ - 会话列表       │       └──────┬───────┘ ◄─────│ SessionManager   │
│ - Git 变更列表   │              │         ws   │ Claude CLI 子进程 │
│ - 文件系统树     │              │               ├──────────────────┤
│ FileViewerModal  │         nginx (TLS)          │ 节点 C (服务器)   │
│ GitDiffModal     │         443 → 3001           │ SessionManager   │
└──────────────────┘                              │ Claude CLI 子进程 │
                                                  └──────────────────┘
```

> 生产部署时，nginx 终止 TLS（HTTPS/WSS），relay 仅监听 `127.0.0.1:3001`，不对外暴露。

## 功能特性

- **多节点管理** — 支持多个远程节点同时在线，前端下拉切换
- **项目管理** — 创建/删除项目，下拉选择器切换项目
- **会话管理** — 创建/停止/删除会话，会话自动持久化与恢复
- **流式对话** — NDJSON 流式解析，实时渲染 Claude 回复
- **Git 变更列表** — 侧边栏 IDEA 风格竖排 tab，展示 staged / unstaged / untracked 文件
- **Git Diff 查看** — 点击变更文件弹出 diff 对比弹窗，按 +/- 着色
- **文件系统树** — VS Code Explorer 风格文件树，可展开/折叠目录
- **文件内容查看器** — 点击文件弹出语法高亮查看器，支持 17 种编程语言
- **Token 用量统计** — 状态栏实时显示 input/output/cache tokens 及成本
- **权限对话** — 工具执行需授权时弹出权限确认对话框

## 部署模式

项目包含三个组件，可灵活部署：

| 组件 | 说明 | 端口 |
|------|------|------|
| **relay** (中继服务) | WebSocket 中转 + 静态文件服务 + HTTP API | 3001 |
| **local** (本地服务) | WS 客户端，连到 relay，管理 Claude CLI 会话 | 无（纯客户端） |
| **frontend** (前端) | React SPA 开发服务器 | 5173 |

三种部署场景：

```
一体机 (restart.sh)          云服务 (restart-cloud.sh)      本地节点 (restart-local.sh)
┌──────────────────┐       ┌──────────────────┐         ┌──────────────────┐
│ relay :3001      │       │ nginx :443 (TLS) │         │                  │
│ local (WS客户端)  │       │ relay :3001      │   wss   │ local (WS客户端)  │
│ frontend :5173   │       │ (仅127.0.0.1)    │ ◄─────── │                  │
└──────────────────┘       └──────────────────┘         └──────────────────┘
     本地开发/演示                  │ 公网服务器                   远程开发机
                                   │
                          RELAY_URL 指向云服务
```

## 快速开始

### 前置要求

- Node.js 22+
- npm 10+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` 命令可用)

### 配置文件

配置按端拆分到各自包内（`packages/relay/.env` 与 `packages/local/.env`），分别复制模板后修改：

```bash
cp packages/relay/.env.example packages/relay/.env
cp packages/local/.env.example packages/local/.env
```

`packages/relay/.env`（中继服务）：

```bash
NODE_ENV=production
RELAY_PORT=3001                 # 监听端口
INITIAL_ADMIN_USER=admin        # 首 admin 种子（仅 users 表为空时创建一次）
INITIAL_ADMIN_PASSWORD=<管理员密码>  # 浏览器登录密码（首启创建首个 admin）
STATIC_DIR=../../frontend/dist  # 前端静态文件路径
```

`packages/local/.env`（本地服务）：

```bash
# 同机器部署（推荐）: ws://127.0.0.1:3001/ws/local
# 跨机器部署（需 nginx 代理 WSS）: wss://your-domain.com/ws/local
RELAY_URL=ws://127.0.0.1:3001/ws/local
NODE_ID=<管理员预注册时指定的节点 ID>      # 必填：管理员在 /admin 预注册 Node 后获得
NODE_SECRET=<预注册后展示一次的注册凭证>    # 必填：每 Node 独立，替代已废弃的 RELAY_TOKEN
RELAY_CA_CERT=                  # wss 自签名证书 CA 路径（留空用系统 CA）
WORKSPACE_ROOT=                 # 项目工作区根目录（留空不限制路径）
RECONNECT_DELAY=2000            # 重连初始延迟（毫秒）
MAX_RECONNECT_DELAY=30000       # 重连最大延迟（毫秒）
CLAUDE_FORCE_PERMISSION_MODE=   # 强制锁定权限模式（留空以前端为准）
```

> Node 注册采用每 Node 独立凭证：管理员先在浏览器 `/admin` 预注册 Node 获得 `(NODE_ID, NODE_SECRET)`，再配置到 local `.env`。未预注册或凭证错的 local 会被 relay 拒绝。全局 `RELAY_TOKEN` 已废弃（见 ADR-0004）。
>
> 前端（`packages/frontend`）由 Vite 自动加载其包内 `.env`，`VITE_WS_URL` 留空即可（前端按页面协议自动选择 ws/wss）。

### 一体机（本地开发 / 演示）

一条命令启动全部三个组件：

```bash
# Linux / macOS
./restart.sh

# Windows
restart.bat
```

### 云服务 + 远程节点（生产部署）

**云服务器上**（启动 relay + frontend）：

```bash
# 1. 配置 packages/relay/.env
#    NODE_ENV=production
#    INITIAL_ADMIN_PASSWORD=<管理员密码>

# 2. 构建前端 & 启动
npm run build:frontend
./restart-cloud.sh

# 3. 浏览器登录 admin 后，到 /admin 预注册 Node 获得 (NODE_ID, NODE_SECRET)
#    （供下一步配置到远程 local）
```

**配置 nginx + HTTPS（生产必须）**：

```bash
# 1. 复制项目自带的 nginx 配置模板
sudo cp nginx.conf.example /etc/nginx/conf.d/cc-web.conf

# 2. 编辑配置，替换 your-domain.com 为实际域名
sudo nano /etc/nginx/conf.d/cc-web.conf

# 3. 申请 TLS 证书（Let's Encrypt）
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com

# 4. 测试并重载 nginx
sudo nginx -t && sudo systemctl reload nginx
```

> 完整的 nginx 配置参见 `nginx.conf.example`，包含 TLS 参数、WebSocket 代理、`/ws/local` IP 白名单等。

**远程开发机上**（仅启动 local，连到云服务）：

```bash
# 1. 修改 packages/local/.env：
#    RELAY_URL=wss://your-domain.com/ws/local  (跨机器必须走 WSS)
#    NODE_ID / NODE_SECRET = 管理员在 /admin 预注册该 Node 时给出的值
# 2. 启动
./restart-local.sh
```

> 可有多台机器各自运行 `restart-local.sh` 连到同一个云服务，前端会列出所有在线节点。

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm install` | 安装所有 workspaces 依赖 |
| `./restart.sh` | 一体机重启：relay + local + frontend |
| `./restart-cloud.sh` | 云服务重启：relay + frontend |
| `./restart-local.sh` | 本地节点重启：local only |
| `npm run dev:relay` | 单独启动中转服务 (默认 :3001) |
| `npm run dev:local` | 单独启动本地服务 |
| `npm run dev:frontend` | 单独启动前端 Vite 开发服务器 (:5173) |
| `npm run build:frontend` | 构建前端生产版本到 dist/ |

## 项目结构

```
cc-web/
├── package.json                  # npm workspaces 根配置
├── tsconfig.base.json            # 共享 TypeScript 配置
├── packages/
│   ├── frontend/                 # React 19 SPA (Vite 7 + TailwindCSS 4)
│   │   └── src/
│   │       ├── App.tsx           # 根组件：布局 + WebSocket Provider
│   │       ├── types.ts          # 消息类型定义（跨组件共享）
│   │       ├── hooks/            # WebSocket / 流解析 / 消息处理
│   │       ├── components/
│   │       │   ├── ChatView.tsx          # 核心视图：WS 连接 + 消息路由 + 状态管理
│   │       │   ├── ChatMessages.tsx      # 消息列表 + 类型分发
│   │       │   ├── MessageComponents.tsx # 8 类消息渲染 (Chat/Thinking/Tool/…)
│   │       │   ├── ChatInput.tsx         # 输入框 + 发送/停止按钮
│   │       │   ├── ProjectSidebar.tsx    # 侧边栏：项目下拉 + 会话/Git/文件 tab
│   │       │   ├── StatusBar.tsx         # 状态栏：连接/模型/Token/任务进度
│   │       │   ├── ModelPicker.tsx       # 模型选择弹窗
│   │       │   ├── PermissionDialog.tsx  # 工具授权确认弹窗
│   │       │   ├── GitChangeList.tsx     # Git 变更文件分组列表
│   │       │   ├── GitDiffModal.tsx      # Git diff 对比弹窗
│   │       │   ├── FileTree.tsx          # 文件系统树（可展开目录）
│   │       │   ├── FileViewerModal.tsx   # 文件内容查看器（语法高亮）
│   │       │   ├── MarkdownRenderer.tsx  # Markdown 渲染
│   │       │   └── messages/            # 消息容器子组件
│   │       ├── utils/            # UnifiedMessageProcessor / 消息转换
│   │       └── config/           # WebSocket URL 配置
│   ├── relay/                    # 中继服务 (Node.js + ws)
│   │   └── src/
│   │       ├── index.ts          # HTTP + WS 双通道服务器
│   │       ├── ws-relay.ts       # 消息转发 + 路由表 + 心跳
│   │       ├── static.ts         # 静态文件服务 + SPA fallback
│   │       └── config.ts         # 端口 / token 配置
│   ├── local/                    # 本地服务 (Node.js)
│   │   └── src/
│   │       ├── index.ts          # 入口：连接中转 + 消息路由
│   │       ├── ws-client.ts      # WebSocket 客户端（自动重连）
│   │       ├── sdk-runner.ts     # spawn claude CLI → NDJSON
│   │       ├── session-manager.ts # 会话生命周期 + JSON 持久化
│   │       └── config.ts         # 中转地址 / Node 凭证配置
│   └── shared/                   # 前后端共享类型
│       └── types.ts              # StreamResponse / ChatRequest / Git/Diff/FileTree
```

## 架构要点

### 通信协议

全部通信使用 NDJSON over WebSocket：

- **浏览器 ↔ 中转** (`/ws/browser`)：消息类型覆盖聊天、会话 CRUD、项目 CRUD、Git status/diff、文件树/内容、节点认证等
- **中转 ↔ 本地** (`/ws/local`)：认证注册 + 双向转发
- **数据消息**：`{ type: "claude_json", data: <SDKMessage> }` 格式，与 claude-code-webui 完全兼容

生产部署时通过 nginx 反向代理提供 HTTPS/WSS 加密：

```
浏览器 ──(HTTPS/WSS)──→ nginx:443 ──(HTTP/WS)──→ relay:127.0.0.1:3001
                                       ↑
本地服务 ──(WSS)────────→ nginx:443 ──┘   (同机器可直连 ws://127.0.0.1:3001)
```

前端根据 `window.location.protocol` 自动选择 `ws://` 或 `wss://`，无需额外配置。

### 复用 claude-code-webui

前端消息处理管线直接复用 [claude-code-webui](https://github.com/sugyan/claude-code-webui)：

- `UnifiedMessageProcessor` — SDK 消息 → UI AllMessage 转换
- `useStreamParser` — NDJSON 逐行解析
- `MessageComponents.tsx` — 8 个消息渲染组件（Chat/Thinking/Tool/ToolResult/Plan/Todo/System/Loading）
- `ChatMessages.tsx` — 消息列表 + 类型分发

### Claude CLI 调用

使用 `child_process.spawn('claude', ...)` 而非 npm SDK（Windows 兼容性）：

```bash
claude --output-format stream-json --verbose -p "用户输入"
```

每条 stdout 行 → `JSON.parse` → `{ type: "claude_json", data: <parsed> }` → WebSocket 发送

### 会话持久化

```
data/sessions/
├── index.json          # ["uuid-1", "uuid-2"]
├── uuid-1.json         # { sessionId, projectPath, messages: [...], ... }
└── uuid-2.json
```

### Git 集成

侧边栏通过 `git status --porcelain` 获取变更文件列表，按 staged / unstaged / untracked 分组展示。点击文件通过 `git diff` 获取 unified diff 文本，在弹窗中按 +/- 行着色渲染。

### 文件系统浏览

通过 Node.js `fs` 模块递归读取目录结构（自动跳过 `node_modules`、`.git` 等），前端以可展开的树形视图展示。点击文件通过 `fs.readFile` 读取内容，根据扩展名自动识别 MIME 类型和编程语言，使用 Prism.js 语法高亮渲染。

### 安全

- **传输加密**：生产部署通过 nginx 提供 HTTPS/WSS（`nginx.conf.example`），relay 仅监听 `127.0.0.1` 不对外暴露
- **认证机制**：
  - 中转 ↔ 本地：每 Node 独立预注册凭证 (`NODE_ID` + `NODE_SECRET`)，管理员在 `/admin` 预注册后下发；未预注册或凭证错的 local 连不上（见 ADR-0004，已废弃全局 `RELAY_TOKEN`）
  - 浏览器 ↔ 中转：多用户登录（用户名 + 密码 → httpOnly cookie session），首个 admin 经 `INITIAL_ADMIN_*` seed
  - 操作授权：Assignment（relay 侧 user↔Node 多对多），被分配的 user 即可完全操作该 Node（见 ADR-0005；已废弃节点密码 `NODE_PASSWORD`）
- **路径安全**：静态文件服务路径穿越防护，API 端点路径白名单
- **部署安全**：本地服务不暴露端口，仅作 WS 客户端

## 技术栈

| 层 | 技术 |
|----|------|
| 前端框架 | React 19 + TypeScript 5 |
| 构建 | Vite 7 |
| 样式 | TailwindCSS 4 |
| 语法高亮 | react-syntax-highlighter (Prism) |
| 中转/本地 | Node.js + ws + TypeScript |
| AI 进程 | Claude CLI (`child_process.spawn`) |
| AI 后端 | DeepSeek API |

## 部署到云服务器

```bash
# 1. 上传整个项目（或至少 packages/relay + packages/frontend + restart-cloud.sh）

# 2. 配置 packages/relay/.env
#    NODE_ENV=production
#    INITIAL_ADMIN_PASSWORD=<管理员密码>
#    RELAY_PORT=3001

# 3. 安装依赖、构建前端、启动
npm install
npm run build:frontend
./restart-cloud.sh

# 4. 配置 nginx + HTTPS（详见 nginx.conf.example）
sudo cp nginx.conf.example /etc/nginx/conf.d/cc-web.conf
# 编辑配置替换域名后：
sudo certbot --nginx -d your-domain.com
sudo nginx -t && sudo systemctl reload nginx
```

本地节点只需项目文件和 `restart-local.sh`：

```bash
# 本地开发机上
# 1. 修改 packages/local/.env：
#    RELAY_URL=wss://your-domain.com/ws/local  (跨机器走 WSS)
#    NODE_ID / NODE_SECRET = 管理员在 /admin 预注册该 Node 时给出的值
# 2. 确保已安装 claude CLI 并可用
npm install
./restart-local.sh
```
