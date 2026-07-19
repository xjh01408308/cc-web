import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { ConnStates } from '../src/conn-state.js';

// ws 句柄在 ConnStates 里只作为 WeakMap key + identity 比较，不调其方法，用裸对象占位即可
function fakeWs(): WebSocket {
  return {} as WebSocket;
}

describe('ConnStates', () => {
  it('init 记录 ip 与连接时刻，并可通过 get 取回', () => {
    const states = new ConnStates();
    const ws = fakeWs();
    const s = states.init(ws, '1.2.3.4', 1000);
    expect(s.ip).toBe('1.2.3.4');
    expect(s.connectedAt).toBe(1000);
    expect(states.get(ws)).toBe(s);
  });

  it('未 init 的 ws：get / getNodeId / getSessionId 均返回 undefined', () => {
    const states = new ConnStates();
    expect(states.get(fakeWs())).toBeUndefined();
    expect(states.getNodeId(fakeWs())).toBeUndefined();
    expect(states.getSessionId(fakeWs())).toBeUndefined();
  });

  it('setNodeId / getNodeId 往返（local 连接 register 后写 nodeId）', () => {
    const states = new ConnStates();
    const ws = fakeWs();
    states.init(ws, '?');
    expect(states.getNodeId(ws)).toBeUndefined();
    states.setNodeId(ws, 'node-1');
    expect(states.getNodeId(ws)).toBe('node-1');
  });

  it('setSessionId / getSessionId 往返（browser 订阅会话后写 sessionId）', () => {
    const states = new ConnStates();
    const ws = fakeWs();
    states.init(ws, '?');
    states.setSessionId(ws, 'sess-1');
    expect(states.getSessionId(ws)).toBe('sess-1');
  });
});
