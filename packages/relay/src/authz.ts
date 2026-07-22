// Assignment 授权的纯判定函数（见 ADR-0005）。
//
// 把"角色 + 授权集合 → 可见 / 可操作"的策略从连接处理层抽出为纯函数：
// 不碰 DB、不碰 ws，入参显式，便于独立单测；admin 全放行，user 仅限 assigned 集。
// ConnectionHandler 在每个节点列表构建 / 每条命令授权判定时调用本模块。

import type { NodeSummary } from './node-registry.js';
import type { UserRole } from './user-store.js';

/**
 * 某 user 可见的在线节点：admin → 全部在线；user → assigned ∩ online。
 * assignedNodeIds 仅对 user 生效（admin 分支直接返回 online，不读它），
 * 故 admin 调用方可传空集避免无谓的 DB 查询。
 */
export function filterVisibleNodes(
  online: NodeSummary[],
  role: UserRole,
  assignedNodeIds: Set<string>,
): NodeSummary[] {
  if (role === 'admin') return online;
  return online.filter((n) => assignedNodeIds.has(n.nodeId));
}

/**
 * 某 user 能否操作指定 node：admin → 恒 true；user → 须在 assigned 集内。
 * 用于每条指向 node 的命令（Chat / CreateSession / 文件 / git 等）的授权门。
 */
export function canOperateNode(
  role: UserRole,
  nodeId: string,
  assignedNodeIds: Set<string>,
): boolean {
  if (role === 'admin') return true;
  return assignedNodeIds.has(nodeId);
}
