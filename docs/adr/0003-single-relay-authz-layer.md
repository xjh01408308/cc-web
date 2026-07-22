---
status: accepted
---

# 单 Relay 授权层：不引入多 Relay 管理平面

在现有单 Relay 跨公网拓扑（Node 本地 ↔ Relay 云主机 ↔ Browser）之上叠加"用户 / 角色 / Node 预注册 / Node 授权"层，**不**引入管理多个 Relay 实例的"管理平面"。仍只有一个 Relay 实例，Browser 直连它；管理员在 Browser 的管理视图内完成预注册 Node、建用户、分配 Node。

否决"多 Relay + 管理平面"：当前痛点（只有预注册的 Node 能连、把 Node 分配给普通用户）全是单 Relay 内的授权问题，不构成管理多 Relay 部署的理由；多 Relay 会把连接模型、用户授权范围、Node 注册目标全盘复杂化，收益不抵成本。若将来确有多 Relay 统一管理需求，再以此 ADR 为起点重评。

## Considered Options

- **理解 A（采用）**：单 Relay + 用户/授权层。
- **理解 B（否决）**：多 Relay + 跨 Relay 管理平面，Browser 可切换 Relay，Node 注册到指定 Relay。

## Consequences

- BrowserAuth 从单密码（`RELAY_PASSWORD`）改为多用户（用户名 + 密码 + 角色）。
- 引入"Node 预注册"概念：管理员预先登记 Node 并生成其注册凭证，未登记的 Node 连不上 Relay。
- Relay 侧需持久化用户表、Node 预注册表、Node→用户授权关系（当前 Relay 认证态纯内存，见部署拓扑约束）。
- 用户原话"添加 relay"在此理解下不成立——管理员添加的是 **Node**，不是 Relay。
