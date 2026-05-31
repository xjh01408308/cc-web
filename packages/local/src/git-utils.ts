import { execSync } from "node:child_process";
import { resolve, sep } from "node:path";
import type { GitStatusResult, GitStatusFile, GitDiffResult } from "./types.js";

function resolveWithin(baseDir: string, targetPath: string): string | null {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, targetPath);
  if (resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + sep)) {
    return resolvedTarget;
  }
  return null;
}

const GIT_TIMEOUT = 5000;

export function getGitStatus(projectPath: string, projectId: string): GitStatusResult {
  const base: GitStatusResult = {
    projectPath,
    projectId,
    isGitRepo: false,
    staged: [],
    unstaged: [],
    untracked: [],
  };

  let raw: string;
  try {
    raw = execSync("git status --porcelain", {
      cwd: projectPath,
      timeout: GIT_TIMEOUT,
      encoding: "utf-8",
      windowsHide: true,
    });
  } catch (err: unknown) {
    const msg = (err as { stderr?: string; message?: string }).stderr
      || (err as { message?: string }).message
      || "";
    if (/not a git repository/i.test(msg)) {
      return base;
    }
    base.error = msg.trimEnd();
    return base;
  }

  base.isGitRepo = true;

  for (const line of raw.split("\n")) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const rest = line.slice(3).trimEnd();

    const file: GitStatusFile = {
      path: rest,
      staged: x !== " " ? x : "",
      unstaged: y !== " " ? y : "",
      displayPath: rest,
    };

    // Handle renames: "R old -> new"
    if (x === "R" || (x === " " && y !== " " && rest.includes(" -> "))) {
      const parts = rest.split(" -> ");
      if (parts.length === 2) {
        file.path = parts[1];
        file.displayPath = rest;
      }
    }

    const index = x !== " " ? x : "";
    const worktree = y !== " " ? y : "";

    if ((index === "?" && worktree === "?") || (index === "?" && !worktree)) {
      base.untracked.push(file);
    } else if (index && worktree) {
      // Both staged and unstaged changes on the same file
      base.staged.push({ ...file, staged: index, unstaged: "" });
      base.unstaged.push({ ...file, staged: "", unstaged: worktree });
    } else if (index) {
      base.staged.push(file);
    } else if (worktree) {
      base.unstaged.push(file);
    }
  }

  return base;
}

function runGitDiff(cmd: string, cwd: string): { diff: string; error?: string } {
  try {
    return { diff: execSync(cmd, { cwd, timeout: GIT_TIMEOUT, encoding: "utf-8", windowsHide: true }) };
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const stdout = (err as { stdout?: string }).stdout || "";
    // exit 0 = no diff, exit 1 = diff present (normal for git diff)
    if (status === 1 && stdout.length > 0) {
      return { diff: stdout };
    }
    if (status && status > 1) {
      return { diff: "", error: (err as { stderr?: string }).stderr || (err as { message?: string }).message || "git diff failed" };
    }
    return { diff: stdout };
  }
}

export function getGitDiff(
  projectPath: string,
  filePath: string,
  staged: boolean,
): GitDiffResult {
  const result: GitDiffResult = { projectPath, filePath, diff: "" };

  const safePath = resolveWithin(projectPath, filePath);
  if (!safePath) {
    result.error = "路径不合法：文件不在项目目录内";
    return result;
  }

  if (staged) {
    const { diff, error } = runGitDiff(`git diff --cached -- "${safePath}"`, projectPath);
    result.diff = diff;
    result.error = error;
    return result;
  }

  // Unstaged: try git diff first; if file is untracked, compare against /dev/null
  const { diff, error } = runGitDiff(`git diff -- "${safePath}"`, projectPath);
  if (!error && diff) {
    result.diff = diff;
    return result;
  }

  // If error mentions "bad revision" or no diff returned, treat as untracked
  if (error || !diff) {
    const absPath = safePath.replace(/\\/g, "/");
    // git diff --no-index always exits 1 when files differ
    const untracked = runGitDiff(`git diff --no-index /dev/null "${absPath}"`, projectPath);
    result.diff = untracked.diff;
    result.error = untracked.error && untracked.diff ? undefined : untracked.error;
  }

  return result;
}
