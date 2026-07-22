---
status: accepted
---

# 废弃 NodeAuth：单层 Assignment 授权

Node 操作授权从"双层"收敛为"单层"：**Assignment**（relay 侧 user↔Node 多对多）是唯一的操作授权机制，被 Assignment 的 user 即可完全操作该 Node。废弃 NodeAuth（`NODE_PASSWORD` / `auth_node` / `passwordRequired`）整条链路——它是旧的"browser 用户操作 Node 时的第二因素解锁密码"，在新模型下被 Assignment 取代。

基于威胁模型判断：本部署 relay 与 local 控制权基本同源（自托管、admin 可信），不需要 local 侧保留独立于 relay 的"否决锁"；双层密码对 user 是纯负担。操作授权完全收口到 relay 侧 Assignment，模型更简洁。

## Considered Options

- **(P) 保留两层，Assignment 管可见 + NodeAuth 管操作解锁，正交（否决）**：local 侧保留独立防线，但双层密码增负担，且本场景不需要 local 否决权。
- **(Q) 单层，Assignment 即完整授权，废弃 NodeAuth（采用）**。

## Consequences

- 删除：`NODE_PASSWORD` 配置与 `isNodePasswordEmpty`；`auth_node` 命令（`BrowserAuthNodeCommand` / `LocalAuthNodeCommand`）、`AuthResult` / `AuthRequired` 事件、`LocalRegisterEvent.passwordRequired`；relay 侧 `NodeConn.passwordRequired` / `authedBrowsers` / `isAuthenticated` / `markAuthenticated` / `isPasswordRequired` / `sendAuthRequired` / AuthNode 速率限制（`authAttempts` / `MAX_AUTH_FAILURES` / `AUTH_COOLDOWN_MS`）；HTTP API 的 `auth_required` 拦截分支（`index.ts` `/api/projects` `/api/sessions`）；frontend `useNodeAuth` hook 及其测试。
- `NodeRegistry.resolveAuthedTarget` / `resolveForSession` 移除认证检查，退化为纯目标解析。
- NodeSecret（local→relay 注册凭证，ADR-0004）**不受影响**——它管"能不能连"，与 NodeAuth（管"操作解锁"）是不同层，勿混淆。
- 安全取舍：relay admin 的 Assignment 决定一切操作权，local 侧不再有独立否决手段。若将来部署模型变为 relay 与 local 控制权分离（半托管 / 多租户），需重评 resurrect NodeAuth。
