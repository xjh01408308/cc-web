// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { BrowserCommandType } from "../types";
import type { BrowserCommand, SessionInfo } from "../types";
import { useSession } from "./useSession";

function renderSession(send: ReturnType<typeof vi.fn> = vi.fn()) {
  return { send, ...renderHook(({ send }) => useSession({ send }), { initialProps: { send } }) };
}

const runningSession = (id: string): SessionInfo => ({
  sessionId: id,
  projectId: "p",
  projectPath: "/p",
  summary: "",
  status: "running",
  messageCount: 0,
  createdAt: 0,
});

describe("useSession — handleSelectProject", () => {
  it("setActiveProjectId + send ListProjects + send ListSessions(by projectId, by activeNodeId)", () => {
    const send = vi.fn();
    const { result } = renderSession(send);

    act(() => result.current.setActiveNodeId("node-1"));
    send.mockClear();

    act(() => result.current.handleSelectProject("proj-1"));

    expect(result.current.activeProjectId).toBe("proj-1");
    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.ListProjects,
      nodeId: "node-1",
    } satisfies BrowserCommand);
    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.ListSessions,
      projectId: "proj-1",
      nodeId: "node-1",
    } satisfies BrowserCommand);
  });

  it("activeNodeId=null → nodeId 传 undefined", () => {
    const send = vi.fn();
    const { result } = renderSession(send);
    act(() => result.current.handleSelectProject("proj-1"));
    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.ListProjects,
      nodeId: undefined,
    } satisfies BrowserCommand);
  });
});

describe("useSession — handleCreateProject", () => {
  it("send CreateProject(name, path, nodeId)", () => {
    const send = vi.fn();
    const { result } = renderSession(send);
    act(() => result.current.setActiveNodeId("node-1"));
    send.mockClear();

    act(() => result.current.handleCreateProject("myproj", "/path/to/proj"));

    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.CreateProject,
      name: "myproj",
      path: "/path/to/proj",
      nodeId: "node-1",
    } satisfies BrowserCommand);
  });
});

describe("useSession — handleDeleteProject", () => {
  it("send DeleteProject(projectId, nodeId)", () => {
    const send = vi.fn();
    const { result } = renderSession(send);
    act(() => result.current.setActiveNodeId("node-1"));
    send.mockClear();

    act(() => result.current.handleDeleteProject("proj-1"));

    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.DeleteProject,
      projectId: "proj-1",
      nodeId: "node-1",
    } satisfies BrowserCommand);
  });
});

describe("useSession — handleStopSession", () => {
  it("send StopSession + 仅 sessions[sessionId].status 置 idle（其它 session 不变）", () => {
    const send = vi.fn();
    const { result } = renderSession(send);

    act(() => {
      result.current.setActiveNodeId("node-1");
      result.current.setSessions([runningSession("s1"), runningSession("s2")]);
    });
    send.mockClear();

    act(() => result.current.handleStopSession("s1"));

    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.StopSession,
      sessionId: "s1",
      nodeId: "node-1",
    } satisfies BrowserCommand);
    expect(result.current.sessions[0].status).toBe("idle");
    expect(result.current.sessions[1].status).toBe("running");
  });
});
