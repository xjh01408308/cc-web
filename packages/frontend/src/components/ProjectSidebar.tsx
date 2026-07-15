import { useState } from "react";
import type { SessionInfo, ProjectInfo, GitStatusResult, FileTreeNode } from "../types";
import { GitChangeList } from "./GitChangeList";
import { FileTree } from "./FileTree";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string, projectId: string) => void;
  onCreateProject: (name: string, path: string) => void;
  onCreateSession: (projectId: string, projectPath: string) => void;
  onDeleteProject: (projectId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  isOpen: boolean;
  isMobile: boolean;
  onClose: () => void;
  gitStatuses: Map<string, GitStatusResult>;
  onRequestGitStatus: (projectId: string, projectPath: string) => void;
  onFileClick: (filePath: string, projectPath: string, staged: boolean) => void;
  fileTrees: Map<string, FileTreeNode[]>;
  fileTreeErrors: Map<string, string>;
  fileTreeLoading: Set<string>;
  onRequestFileTree: (projectPath: string, projectId: string) => void;
  onFileTreeNodeClick: (filePath: string, projectPath: string) => void;
  defaultProjectPath: string;
}

function statusColor(status: string) {
  switch (status) {
    case "running":
      return "bg-green-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-slate-400";
  }
}

export function ProjectSidebar({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
  onCreateProject,
  onCreateSession,
  onDeleteProject,
  onDeleteSession,
  onStopSession,
  isOpen,
  isMobile,
  onClose,
  gitStatuses,
  onRequestGitStatus,
  onFileClick,
  fileTrees,
  fileTreeErrors,
  fileTreeLoading,
  onRequestFileTree,
  onFileTreeNodeClick,
  defaultProjectPath,
}: ProjectSidebarProps) {
  const [activeTab, setActiveTab] = useState<Map<string, 'sessions' | 'git' | 'files'>>(new Map());

  const activeProject = projects.find((p) => p.projectId === activeProjectId);
  const tab = activeTab.get(activeProjectId || '') || 'sessions';

  const setTab = (t: 'sessions' | 'git' | 'files') => {
    if (!activeProjectId) return;
    setActiveTab((prev) => {
      const next = new Map(prev);
      next.set(activeProjectId, t);
      return next;
    });
  };

  const handleCreateProject = () => {
    const name = prompt("请输入项目名称:", "");
    if (!name) return;
    const projectPath = prompt("请输入项目路径:", defaultProjectPath);
    if (!projectPath) return;
    onCreateProject(name, projectPath);
  };

  const handleCreateSession = () => {
    if (!activeProject) return;
    onCreateSession(activeProject.projectId, activeProject.path);
  };

  const handleSelectSession = (sessionId: string, projectId: string) => {
    onSelectSession(sessionId, projectId);
    if (isMobile) onClose();
  };

  const projectSessions = activeProjectId
    ? sessions
        .filter((s) => s.projectId === activeProjectId)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];

  const gitStatus = activeProjectId ? gitStatuses.get(activeProjectId) : undefined;
  const hasGitChanges =
    gitStatus &&
    gitStatus.isGitRepo &&
    (gitStatus.staged.length > 0 ||
      gitStatus.unstaged.length > 0 ||
      gitStatus.untracked.length > 0);

  const sidebarContent = (
    <div className="h-full flex flex-col bg-white/80 dark:bg-slate-800/80 border-r border-slate-200 dark:border-slate-700">
      {/* Header with project dropdown */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
            项目
          </span>
          <select
            value={activeProjectId || ""}
            onChange={(e) => {
              const projectId = e.target.value;
              if (projectId) {
                onSelectProject(projectId);
                const project = projects.find((p) => p.projectId === projectId);
                if (project) {
                  onRequestGitStatus(projectId, project.path);
                }
              }
            }}
            className="flex-1 min-w-0 text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 truncate cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>
              选择项目...
            </option>
            {Array.isArray(projects) &&
              projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                </option>
              ))}
          </select>
          <button
            onClick={handleCreateProject}
            className="flex-shrink-0 p-1.5 text-blue-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded transition-colors"
            title="新建项目"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
          {isMobile && (
            <button
              onClick={onClose}
              className="flex-shrink-0 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded transition-colors"
            >
              ✕
            </button>
          )}
        </div>

        {/* Selected project info bar */}
        {activeProject && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-slate-600 dark:text-slate-300 truncate flex-1">
              {activeProject.name}
            </span>
            <button
              onClick={() => {
                if (
                  confirm(
                    `确定删除项目 "${activeProject.name}" 及其所有会话？`,
                  )
                ) {
                  onDeleteProject(activeProject.projectId);
                }
              }}
              className="flex-shrink-0 p-1 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
              title="删除项目"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Tab bar + Content (only when a project is selected) */}
      {activeProject ? (
        <>
          {/* Vertical tab bar */}
          <div className="flex flex-1 overflow-hidden border-b border-slate-200 dark:border-slate-700">
            <div className="flex flex-col w-9 border-r border-slate-200 dark:border-slate-700 py-1 gap-0.5 flex-shrink-0">
              <button
                onClick={() => setTab("sessions")}
                className={`flex flex-col items-center py-1.5 text-[10px] leading-tight rounded-sm mx-0.5 transition-colors ${
                  tab === "sessions"
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50"
                }`}
                title="会话"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                  />
                </svg>
                <span className="mt-0.5" style={{ writingMode: "vertical-rl" }}>
                  会话
                </span>
              </button>
              <button
                onClick={() => {
                  setTab("git");
                  onRequestGitStatus(
                    activeProject.projectId,
                    activeProject.path,
                  );
                }}
                className={`flex flex-col items-center py-1.5 text-[10px] leading-tight rounded-sm mx-0.5 transition-colors relative ${
                  tab === "git"
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50"
                }`}
                title="Git"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M12 13l-3 3m0 0l3 3m-3-3h8"
                  />
                </svg>
                <span className="mt-0.5" style={{ writingMode: "vertical-rl" }}>
                  Git
                </span>
                {hasGitChanges && (
                  <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-emerald-500" />
                )}
              </button>
              <button
                onClick={() => {
                  setTab("files");
                  onRequestFileTree(
                    activeProject.path,
                    activeProject.projectId,
                  );
                }}
                className={`flex flex-col items-center py-1.5 text-[10px] leading-tight rounded-sm mx-0.5 transition-colors ${
                  tab === "files"
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50"
                }`}
                title="文件"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                  />
                </svg>
                <span className="mt-0.5" style={{ writingMode: "vertical-rl" }}>
                  文件
                </span>
              </button>
            </div>

            {/* Content area */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex-1 overflow-y-auto">
                {tab === "sessions" ? (
                  <div className="p-1">
                    {projectSessions.length === 0 ? (
                      <p className="text-xs text-slate-400 px-3 py-4 text-center">
                        暂无会话
                      </p>
                    ) : (
                      projectSessions.map((s) => (
                        <div
                          key={s.sessionId}
                          onClick={() =>
                            handleSelectSession(
                              s.sessionId,
                              activeProject.projectId,
                            )
                          }
                          className={`mb-0.5 p-2.5 rounded-lg cursor-pointer transition-colors ${
                            activeSessionId === s.sessionId
                              ? "bg-blue-100 dark:bg-blue-800/40 border border-blue-300 dark:border-blue-600"
                              : "hover:bg-slate-50 dark:hover:bg-slate-700/50 border border-transparent"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColor(s.status)}`}
                            />
                            <span className="text-sm text-slate-700 dark:text-slate-200 truncate flex-1">
                              {s.summary || "新会话"}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm("确定删除该会话？")) {
                                  onDeleteSession(s.sessionId);
                                }
                              }}
                              className="text-xs text-red-400 hover:text-red-600 flex-shrink-0 px-1"
                              title="删除会话"
                            >
                              ✕
                            </button>
                          </div>
                          <div className="mt-1 flex items-center justify-between">
                            <span className="text-xs text-slate-400">
                              {s.messageCount} 条消息
                            </span>
                            <span className="text-xs text-slate-400">
                              {new Date(s.createdAt).toLocaleDateString()}
                            </span>
                            {s.status === "running" && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onStopSession(s.sessionId);
                                }}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                停止
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ) : tab === "git" ? (
                  <GitChangeList
                    gitStatus={gitStatus}
                    onFileClick={(filePath, staged) =>
                      onFileClick(filePath, activeProject.path, staged)
                    }
                  />
                ) : (
                  <div className="py-1">
                    {fileTreeLoading.has(activeProject.projectId) ? (
                      <p className="text-xs text-slate-400 px-3 py-4 text-center">
                        加载中...
                      </p>
                    ) : fileTreeErrors.get(activeProject.projectId) ? (
                      <p className="text-xs text-red-400 px-3 py-4 text-center">
                        {fileTreeErrors.get(activeProject.projectId)}
                      </p>
                    ) : (
                      <FileTree
                        tree={
                          fileTrees.get(activeProject.projectId) || []
                        }
                        projectPath={activeProject.path}
                        onFileClick={onFileTreeNodeClick}
                      />
                    )}
                  </div>
                )}
              </div>
              {/* New session button fixed at bottom of sessions tab */}
              {tab === "sessions" && (
                <div className="p-3 border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
                  <button
                    onClick={handleCreateSession}
                    className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
                  >
                    + 新建会话
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        /* Empty state when no project selected */
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-slate-400 dark:text-slate-500 text-center">
            {!Array.isArray(projects) || projects.length === 0
              ? "暂无项目，点击上方 ＋ 新建"
              : "请选择一个项目"}
          </p>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        <div
          className={`fixed inset-0 bg-black/40 z-30 transition-opacity duration-300 ${
            isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          onClick={onClose}
        />
        {/* Drawer */}
        <div
          className={`fixed inset-y-0 left-0 z-40 w-[300px] transition-transform duration-300 ease-in-out ${
            isOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {sidebarContent}
        </div>
      </>
    );
  }

  return (
    <div
      className={`flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out ${
        isOpen ? "w-[300px]" : "w-0"
      }`}
    >
      <div className="w-[300px] h-full">{sidebarContent}</div>
    </div>
  );
}
