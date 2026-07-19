# cc-web

Browser 端经 Relay 远程操控多台 Node 上 Claude Code CLI 的架构。Browser 通过 HTTP API + WebSocket 连 Relay，Relay 通过 WebSocket 连多个 Node。

## 架构三端

**Browser**:
用户操作的 web 前端，经 HTTP API + WebSocket 连 Relay。

**Relay**:
转发服务，提供 HTTP API 与 WebSocket 中继，单实例。

**Node（节点）**:
运行 Claude Code CLI 的本地实例，经 WebSocket 连 Relay。一个 Relay 可挂多个 Node。
_Avoid_: agent, worker, daemon

## 两层认证

> "auth" 在本项目 overloaded——任何使用都必须明确是 BrowserAuth 还是 NodeAuth。

**BrowserAuth**:
Browser 访问 Relay 的认证，HTTP cookie session + 密码（`/api/login`）。
_Avoid_: 登录, login, web auth, "auth"（单独使用）

**NodeAuth**:
Relay 访问 Node 的认证，节点密码经 WebSocket `AuthNode` 命令完成。每个 Node 可要求独立密码。
_Avoid_: 节点密码（作为术语）, node password, "auth"（单独使用）

## 业务实体

**Project**:
Node 上的一个工作目录项目，属某 Node。
_Avoid_: 仓库, repo, workspace

**Session**:
一次 Claude Code 会话，绑定某 Project，含消息历史与运行状态（running/idle）。一个 Project 可有多个 Session。

**Chat（对话流）**:
当前 Session 的实时消息流及其运行时元数据（token 用量、task 进度、权限拒绝）。与 Session 的区别：Session 是"会话实体"（列表 / CRUD / 历史），Chat 是"当前会话的活跃对话状态"。
_Avoid_: 把 Chat 与 Session 混用
