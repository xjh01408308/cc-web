---
status: accepted
---

# Node 注册凭证：每 Node 独立 (nodeId, nodeSecret)

local 连 relay 的注册认证从"全局共享 `RELAY_TOKEN`"改为"每 Node 独立凭证"。管理员在管理视图预注册 Node 时生成 `(nodeId, nodeSecret)` 一对，配置到 local `.env`（新增 `NODE_SECRET`，`NODE_ID` 由管理员显式指定、不再默认 hostname）。local `register` 带 `nodeId + nodeSecret`，relay 查预注册表校验——未预注册的 Node 连不上。

这是"只有添加过的 local 才能登录"与"local↔relay 链路凭证独立于 front↔relay"两条需求的共同落点：凭证由管理员预发即天然白名单；Node 用 nodeSecret、Browser 用"用户名+密码"，两套凭证彻底分离（物理链路 `/ws/local` 与 `/ws/browser` 本就独立，见 `index.ts:237/264`）。

## Considered Options

- **(a) 每 Node 独立 (nodeId, nodeSecret)，废弃全局 RELAY_TOKEN（采用）**。
- **(b) nodeId 白名单 + 保留全局 RELAY_TOKEN（否决）**：全局 token 是两端凭证的耦合点，且仅校验 nodeId 不防冒名。
- **(c) 一次性注册邀请码 / enroll token（否决）**：多一层"注册→换发"状态机，单管理员场景不值得。

## Consequences

- 全局 `RELAY_TOKEN` 作 Node 注册认证**直接废弃**，不留兼容回退（留则成安全后门，与"凭证独立"相悖）；`isUsingDefaultRelayToken()` 告警一并移除。
- nodeId 由管理员定义、全局唯一；现有以 hostname 为 nodeId 的 local 需迁移为显式 `NODE_ID`。
- `NODE_PASSWORD`（NodeAuth 解锁密码）正交保留，不受影响——注册凭证管"能不能连"，NodeAuth 管"连上后 browser 用户能不能操作"，是两道正交的关。
- `LocalRegisterEvent` 协议字段从 `token` 调整为 `nodeId + nodeSecret`。
