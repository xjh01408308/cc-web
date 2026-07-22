import { describe, it, expect } from 'vitest';
import { filterVisibleNodes, canOperateNode } from '../src/authz.js';
import type { NodeSummary } from '../src/node-registry.js';
import type { UserRole } from '../src/user-store.js';

function node(nodeId: string): NodeSummary {
  return { nodeId, sessionCount: 0 };
}

const ONLINE = [node('n1'), node('n2'), node('n3')];

describe('filterVisibleNodes — admin 全访问', () => {
  it('admin → 返回全部在线节点（忽略 assignedNodeIds）', () => {
    const out = filterVisibleNodes(ONLINE, 'admin' as UserRole, new Set(['n1']));
    expect(out.map((n) => n.nodeId)).toEqual(['n1', 'n2', 'n3']);
  });

  it('admin + 空 assigned 集 → 仍全部', () => {
    const out = filterVisibleNodes(ONLINE, 'admin' as UserRole, new Set());
    expect(out).toHaveLength(3);
  });
});

describe('filterVisibleNodes — user 仅 assigned ∩ online', () => {
  it('user assigned {n1,n3} → 只见 n1,n3（n2 不可见）', () => {
    const out = filterVisibleNodes(ONLINE, 'user' as UserRole, new Set(['n1', 'n3']));
    expect(out.map((n) => n.nodeId)).toEqual(['n1', 'n3']);
  });

  it('user assigned 含离线 node → 不出现（仅取 ∩ online）', () => {
    const out = filterVisibleNodes(ONLINE, 'user' as UserRole, new Set(['n1', 'gone']));
    expect(out.map((n) => n.nodeId)).toEqual(['n1']);
  });

  it('user 无任何 assignment → 空列表', () => {
    const out = filterVisibleNodes(ONLINE, 'user' as UserRole, new Set());
    expect(out).toEqual([]);
  });

  it('不修改入参数组（纯函数）', () => {
    const online = [node('n1')];
    filterVisibleNodes(online, 'user' as UserRole, new Set());
    expect(online).toHaveLength(1);
  });
});

describe('canOperateNode — 操作授权判定', () => {
  it('admin → 任意 nodeId 均 true', () => {
    expect(canOperateNode('admin' as UserRole, 'n1', new Set())).toBe(true);
    expect(canOperateNode('admin' as UserRole, 'anything', new Set())).toBe(true);
  });

  it('user assigned 该 node → true', () => {
    expect(canOperateNode('user' as UserRole, 'n1', new Set(['n1', 'n2']))).toBe(true);
  });

  it('user 未 assigned 该 node → false（即便 node 在线）', () => {
    expect(canOperateNode('user' as UserRole, 'n2', new Set(['n1']))).toBe(false);
  });

  it('user 空 assigned 集 → 任意 node 均 false', () => {
    expect(canOperateNode('user' as UserRole, 'n1', new Set())).toBe(false);
  });
});
