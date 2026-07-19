import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { NodeRegistry, type NodeConn } from '../src/node-registry.js';

function fakeWs(): WebSocket {
  return {} as WebSocket;
}
function conn(nodeId: string, opts: Partial<NodeConn> = {}): NodeConn {
  return { ws: fakeWs(), nodeId, passwordRequired: false, ...opts };
}

describe('NodeRegistry — 节点注册', () => {
  it('register 新节点：get / has / size 正确，返回 undefined', () => {
    const reg = new NodeRegistry();
    const c = conn('n1');
    expect(reg.register('n1', c)).toBeUndefined();
    expect(reg.has('n1')).toBe(true);
    expect(reg.get('n1')).toBe(c);
    expect(reg.size).toBe(1);
  });

  it('register 同 nodeId 重连：返回旧 conn 并替换（size 不变）', () => {
    const reg = new NodeRegistry();
    const old = conn('n1');
    const fresh = conn('n1');
    reg.register('n1', old);
    expect(reg.register('n1', fresh)).toBe(old);
    expect(reg.get('n1')).toBe(fresh);
    expect(reg.size).toBe(1);
  });

  it('unregister 返回被删 conn；再删返回 undefined', () => {
    const reg = new NodeRegistry();
    const c = conn('n1');
    reg.register('n1', c);
    expect(reg.unregister('n1')).toBe(c);
    expect(reg.has('n1')).toBe(false);
    expect(reg.unregister('n1')).toBeUndefined();
  });

  it('anyConn 返回注册顺序首个；空时 undefined', () => {
    const reg = new NodeRegistry();
    expect(reg.anyConn()).toBeUndefined();
    const c1 = conn('n1'); reg.register('n1', c1);
    reg.register('n2', conn('n2'));
    expect(reg.anyConn()).toBe(c1);
  });
});

describe('NodeRegistry — 会话 ↔ 节点', () => {
  it('bindSession / nodeForSession / sessionCountOfNode', () => {
    const reg = new NodeRegistry();
    reg.bindSession('s1', 'n1');
    reg.bindSession('s2', 'n1');
    expect(reg.nodeForSession('s1')).toBe('n1');
    expect(reg.sessionCountOfNode('n1')).toBe(2);
    expect(reg.sessionCountOfNode('nope')).toBe(0);
  });

  it('forgetSession 返回原 nodeId 并清映射；再删返回 undefined', () => {
    const reg = new NodeRegistry();
    reg.bindSession('s1', 'n1');
    expect(reg.forgetSession('s1')).toBe('n1');
    expect(reg.nodeForSession('s1')).toBeUndefined();
    expect(reg.forgetSession('s1')).toBeUndefined();
  });

  it('forgetSessionsOfNode 删该节点全部会话、保留其它节点、返回被删列表', () => {
    const reg = new NodeRegistry();
    reg.bindSession('s1', 'n1');
    reg.bindSession('s2', 'n1');
    reg.bindSession('s3', 'n2');
    const dropped = reg.forgetSessionsOfNode('n1');
    expect(dropped.sort()).toEqual(['s1', 's2']);
    expect(reg.nodeForSession('s1')).toBeUndefined();
    expect(reg.nodeForSession('s3')).toBe('n2');
  });
});

describe('NodeRegistry — 浏览器选中节点 + 认证', () => {
  it('selectNodeForBrowser / selectedNodeOfBrowser / forgetBrowser', () => {
    const reg = new NodeRegistry();
    const ws = fakeWs();
    reg.selectNodeForBrowser(ws, 'n1');
    expect(reg.selectedNodeOfBrowser(ws)).toBe('n1');
    reg.forgetBrowser(ws);
    expect(reg.selectedNodeOfBrowser(ws)).toBeUndefined();
  });

  it('isAuthenticated：节点不需密码 → 恒 true', () => {
    const reg = new NodeRegistry();
    reg.register('n1', conn('n1', { passwordRequired: false }));
    expect(reg.isAuthenticated(fakeWs(), 'n1')).toBe(true);
  });

  it('isAuthenticated：需密码，未认证 false → markAuthenticated → true；forgetBrowser 清零', () => {
    const reg = new NodeRegistry();
    reg.register('n1', conn('n1', { passwordRequired: true }));
    const ws = fakeWs();
    expect(reg.isAuthenticated(ws, 'n1')).toBe(false);
    reg.markAuthenticated(ws, 'n1');
    expect(reg.isAuthenticated(ws, 'n1')).toBe(true);
    reg.forgetBrowser(ws);
    expect(reg.isAuthenticated(ws, 'n1')).toBe(false);
  });

  // 与原 ws-relay.ts 行为保持：`if (!node || !node.passwordRequired) return true`
  // 未知节点命中 !node 分支也返回 true；调用方须先经 resolveTarget/has 确认节点存在。
  it('isAuthenticated：未知节点 → true（原 quirk；调用方须先确认节点在线）', () => {
    expect(new NodeRegistry().isAuthenticated(fakeWs(), 'nope')).toBe(true);
  });
});

describe('NodeRegistry — resolveTarget（browser 消息目标解析）', () => {
  it('无显式、单节点 → 自动选唯一', () => {
    const reg = new NodeRegistry();
    const c1 = conn('n1'); reg.register('n1', c1);
    expect(reg.resolveTarget(fakeWs())).toEqual({ ok: true, nodeId: 'n1', conn: c1 });
  });

  it('无显式、无节点 → no-selection', () => {
    expect(new NodeRegistry().resolveTarget(fakeWs())).toEqual({ ok: false, reason: 'no-selection' });
  });

  it('无显式、多节点 → no-selection', () => {
    const reg = new NodeRegistry();
    reg.register('n1', conn('n1'));
    reg.register('n2', conn('n2'));
    expect(reg.resolveTarget(fakeWs())).toEqual({ ok: false, reason: 'no-selection' });
  });

  it('browser 已选中在线节点 → 用选中（即便存在其它节点）', () => {
    const reg = new NodeRegistry();
    const c2 = conn('n2'); reg.register('n2', c2);
    reg.register('n1', conn('n1'));
    const ws = fakeWs();
    reg.selectNodeForBrowser(ws, 'n2');
    expect(reg.resolveTarget(ws)).toEqual({ ok: true, nodeId: 'n2', conn: c2 });
  });

  it('browser 选中节点已离线 + 多节点 → no-selection（选中失效后无法自动选）', () => {
    const reg = new NodeRegistry();
    reg.register('n1', conn('n1'));
    reg.register('n2', conn('n2'));
    const ws = fakeWs();
    reg.selectNodeForBrowser(ws, 'gone');
    expect(reg.resolveTarget(ws)).toEqual({ ok: false, reason: 'no-selection' });
  });

  it('显式 nodeId 在线 → 用显式', () => {
    const reg = new NodeRegistry();
    const c1 = conn('n1'); reg.register('n1', c1);
    reg.register('n2', conn('n2'));
    expect(reg.resolveTarget(fakeWs(), 'n1')).toEqual({ ok: true, nodeId: 'n1', conn: c1 });
  });

  it('显式 nodeId 离线 → offline（不 fallback 到自动选择）', () => {
    const reg = new NodeRegistry();
    reg.register('n1', conn('n1'));
    expect(reg.resolveTarget(fakeWs(), 'gone')).toEqual({ ok: false, reason: 'offline', nodeId: 'gone' });
  });
});

describe('NodeRegistry — 列表与查询', () => {
  it('listNodes 聚合 sessionCount / passwordRequired / workspaceRoot', () => {
    const reg = new NodeRegistry();
    reg.register('n1', conn('n1', { passwordRequired: true, workspaceRoot: '/a' }));
    reg.register('n2', conn('n2', { passwordRequired: false }));
    reg.bindSession('s1', 'n1');
    reg.bindSession('s2', 'n1');
    const list = reg.listNodes();
    expect(list).toContainEqual({ nodeId: 'n1', sessionCount: 2, passwordRequired: true, workspaceRoot: '/a' });
    expect(list).toContainEqual({ nodeId: 'n2', sessionCount: 0, passwordRequired: false, workspaceRoot: undefined });
  });

  it('isPasswordRequired 直接查节点；未知节点 false', () => {
    const reg = new NodeRegistry();
    reg.register('n1', conn('n1', { passwordRequired: true }));
    expect(reg.isPasswordRequired('n1')).toBe(true);
    expect(reg.isPasswordRequired('nope')).toBe(false);
  });
});
