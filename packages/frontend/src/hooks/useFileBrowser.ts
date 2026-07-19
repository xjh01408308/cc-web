import { useState, useCallback } from "react";
import type { GitStatusResult, FileTreeNode } from "../types";
import { BrowserCommandType } from "../types";
import type { BrowserCommand } from "../types";
import type { DiffState, FileViewState } from "../ws/dispatcher";

// 文件浏览域：git 状态 / diff / 文件树 / 文件内容。
// 不提升进 ProjectSidebar —— diffState/fileViewState 还喂 ChatView 级的
// GitDiffModal / FileViewerModal（见 ADR 0002）。
export function useFileBrowser({
  send,
  activeNodeId,
}: {
  send: (data: BrowserCommand) => void;
  activeNodeId: string | null;
}) {
  const [gitStatuses, setGitStatuses] = useState<Map<string, GitStatusResult>>(new Map());
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [fileTrees, setFileTrees] = useState<Map<string, FileTreeNode[]>>(new Map());
  const [fileTreeErrors, setFileTreeErrors] = useState<Map<string, string>>(new Map());
  const [fileTreeLoading, setFileTreeLoading] = useState<Set<string>>(new Set());
  const [fileViewState, setFileViewState] = useState<FileViewState | null>(null);

  const handleRequestGitStatus = useCallback(
    (projectId: string, projectPath: string) => {
      send({ type: BrowserCommandType.GetGitStatus, projectPath, projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleFileClick = useCallback(
    (filePath: string, projectPath: string, staged: boolean) => {
      send({ type: BrowserCommandType.GetGitDiff, projectPath, filePath, staged, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleRequestFileTree = useCallback(
    (projectPath: string, projectId: string) => {
      if (fileTrees.has(projectId)) return;
      setFileTreeLoading((prev) => new Set(prev).add(projectId));
      send({ type: BrowserCommandType.GetFileTree, projectPath, projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId, fileTrees],
  );

  const handleFileTreeNodeClick = useCallback(
    (filePath: string, projectPath: string) => {
      send({ type: BrowserCommandType.GetFileContent, projectPath, filePath, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  return {
    gitStatuses,
    setGitStatuses,
    diffState,
    setDiffState,
    fileTrees,
    setFileTrees,
    fileTreeErrors,
    setFileTreeErrors,
    fileTreeLoading,
    setFileTreeLoading,
    fileViewState,
    setFileViewState,
    handleRequestGitStatus,
    handleFileClick,
    handleRequestFileTree,
    handleFileTreeNodeClick,
  };
}
