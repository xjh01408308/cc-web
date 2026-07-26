# cc-web

Browser 端经 Relay 远程操控多台 Node 上 Claude Code CLI 的架构。Browser 通过 HTTP API + WebSocket 连 Relay，Relay 通过 WebSocket 连多个 Node。

## 架构三端

**Browser**:
用户操作的 web 前端，经 HTTP API + WebSocket 连 Relay。
_Avoid_: front, 前端（作为术语）, web client

**Relay**:
转发服务，提供 HTTP API 与 WebSocket 中继，单实例，同时承载用户与 Node 管理。
_Avoid_: 中转, proxy

**Node（节点）**:
运行 Claude Code CLI 的本地实例，经 WebSocket 连 Relay。一个 Relay 可挂多个 Node；须由管理员预注册并持有 nodeSecret 才能注册成功。
_Avoid_: local, agent, worker, daemon

## 凭证体系

> 两套连接认证凭证：BrowserAuth 管 Browser→Relay，NodeSecret 管 local→Relay。操作授权另见 Assignment。

**BrowserAuth**:
Browser 访问 Relay 的认证，用户名 + 密码（`/api/login`）→ httpOnly cookie session。
_Avoid_: 登录, login, web auth, "auth"（单独使用）

**NodeSecret（注册凭证）**:
local 连 Relay 时证明"我是被管理员预注册过的 Node"，每 Node 独立，由管理员预发生成。Relay 据此判定 Node 能否注册成功。
_Avoid_: RELAY_TOKEN（已废弃）, 节点 token, 节点密码（指注册）

## 用户与角色

**User（用户）**:
Browser 端的登录账户（用户名 + 密码），由 admin 创建。
_Avoid_: 账号, account

**admin（管理员）**:
特权角色：全访问所有 Node（无需 Assignment）、预注册 Node、管理 User、分配 Node。系统首个 admin 经环境变量 seed 生成。

**user（普通用户）**:
普通角色：只能看/操作被 Assignment 给自己的 Node；未分配的 Node 对其完全隐藏（不知其存在）。

**Assignment**:
把某 Node 授权给某 User 的关系，多对多（一个 Node 可授权多个 User，一个 User 可持有多个 Node）。是唯一的操作授权机制——被 Assignment 的 user 即可完全操作该 Node。
_Avoid_: 分配（作为术语）

**修改密码（changePassword）**:
用户改自己的登录密码；必须先验证当前密码，对所有角色（含 admin）一致。
_Avoid_: 改密（口语），与「重置密码」混用

**重置密码（resetPassword）**:
admin 改某个普通 user 的密码；不需该 user 的当前密码，目标只能是普通 user。
_Avoid_: 重置（单独使用），与「修改密码」混用

## 业务实体

**Project**:
Node 上的一个工作目录项目，属某 Node。
_Avoid_: 仓库, repo, workspace

**Session**:
一次 Claude Code 会话，绑定某 Project，含消息历史与运行状态（running/idle）。一个 Project 可有多个 Session。

**Chat（对话流）**:
当前 Session 的实时消息流及其运行时元数据（token 用量、task 进度、权限拒绝）。与 Session 的区别：Session 是"会话实体"（列表 / CRUD / 历史），Chat 是"当前会话的活跃对话状态"。
_Avoid_: 把 Chat 与 Session 混用
