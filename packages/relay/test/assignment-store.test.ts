import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AssignmentStore } from '../src/assignment-store.js';

// 每例独立临时 db（与 node-store.test / user-store.test 同构）。
function tmpStore(): { store: AssignmentStore; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `cc-web-assign-test-${randomUUID()}.db`);
  const store = new AssignmentStore(dbPath);
  const cleanup = (): void => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  };
  return { store, cleanup };
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function makeStore(): AssignmentStore {
  const t = tmpStore();
  cleanup = t.cleanup;
  return t.store;
}

describe('AssignmentStore — assign / revoke（多对多）', () => {
  it('assign 后 assignedNodeIds 含该 node；重复 assign 幂等（不重复行）', () => {
    const store = makeStore();
    store.assign('u1', 'n1');
    expect(store.assignedNodeIds('u1')).toEqual(['n1']);
    store.assign('u1', 'n1'); // 幂等
    expect(store.assignedNodeIds('u1')).toEqual(['n1']);
  });

  it('一个 user 多个 node / 一个 node 多个 user（多对多）', () => {
    const store = makeStore();
    store.assign('u1', 'n1');
    store.assign('u1', 'n2');
    store.assign('u2', 'n1');
    expect(store.assignedNodeIds('u1').sort()).toEqual(['n1', 'n2']);
    expect(store.assignedNodeIds('u2')).toEqual(['n1']);
  });

  it('revoke 命中 → 返回 true 并移除；未命中 → 返回 false', () => {
    const store = makeStore();
    store.assign('u1', 'n1');
    expect(store.revoke('u1', 'n1')).toBe(true);
    expect(store.assignedNodeIds('u1')).toEqual([]);
    expect(store.revoke('u1', 'n1')).toBe(false);
  });

  it('revoke 只影响指定 node，不动其它 assignment', () => {
    const store = makeStore();
    store.assign('u1', 'n1');
    store.assign('u1', 'n2');
    store.revoke('u1', 'n1');
    expect(store.assignedNodeIds('u1')).toEqual(['n2']);
  });
});

describe('AssignmentStore — setAssigned（全量替换，PUT 语义）', () => {
  it('空 → 设 [n1,n2] → assignedNodeIds 为 [n1,n2]', () => {
    const store = makeStore();
    store.setAssigned('u1', ['n1', 'n2']);
    expect(store.assignedNodeIds('u1').sort()).toEqual(['n1', 'n2']);
  });

  it('已有 [n1,n2,n3] → 设 [n2,n4] → 恰好为 [n2,n4]（增 n4、删 n1/n3）', () => {
    const store = makeStore();
    store.setAssigned('u1', ['n1', 'n2', 'n3']);
    store.setAssigned('u1', ['n2', 'n4']);
    expect(store.assignedNodeIds('u1').sort()).toEqual(['n2', 'n4']);
  });

  it('设空数组 → 清空该 user 全部 assignment', () => {
    const store = makeStore();
    store.setAssigned('u1', ['n1', 'n2']);
    store.setAssigned('u1', []);
    expect(store.assignedNodeIds('u1')).toEqual([]);
  });

  it('setAssigned 只影响指定 user，不动其它 user', () => {
    const store = makeStore();
    store.assign('u1', 'n1');
    store.assign('u2', 'n1');
    store.setAssigned('u1', ['n2']);
    expect(store.assignedNodeIds('u1')).toEqual(['n2']);
    expect(store.assignedNodeIds('u2')).toEqual(['n1']);
  });

  it('setAssigned 去重（入参含重复 nodeId 不产生重复行）', () => {
    const store = makeStore();
    store.setAssigned('u1', ['n1', 'n1', 'n2']);
    expect(store.assignedNodeIds('u1').sort()).toEqual(['n1', 'n2']);
  });
});

describe('AssignmentStore — 级联清理', () => {
  it('revokeAllForUser 删该 user 全部 assignment，不动其它 user', () => {
    const store = makeStore();
    store.assign('u1', 'n1');
    store.assign('u1', 'n2');
    store.assign('u2', 'n1');
    expect(store.revokeAllForUser('u1')).toBe(2);
    expect(store.assignedNodeIds('u1')).toEqual([]);
    expect(store.assignedNodeIds('u2')).toEqual(['n1']);
  });

  it('revokeAllForNode 删该 node 全部 assignment，不动其它 node', () => {
    const store = makeStore();
    store.assign('u1', 'n1');
    store.assign('u2', 'n1');
    store.assign('u1', 'n2');
    expect(store.revokeAllForNode('n1')).toBe(2);
    expect(store.assignedNodeIds('u1')).toEqual(['n2']);
    expect(store.assignedNodeIds('u2')).toEqual([]);
  });
});
