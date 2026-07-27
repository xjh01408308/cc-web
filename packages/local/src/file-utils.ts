import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { FileTreeNode, FileTreeResult, FileContentResult } from "./types.js";

export function resolveWithin(baseDir: string, targetPath: string): string | null {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, targetPath);
  if (resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + sep)) {
    return resolvedTarget;
  }
  return null;
}

export function validateProjectPath(projectPath: string, workspaceRoot: string): string | null {
  if (!workspaceRoot) return null;
  if (!resolveWithin(workspaceRoot, projectPath)) {
    return `项目路径必须在 WORKSPACE_ROOT (${workspaceRoot}) 目录内`;
  }
  return null;
}

const SKIP_PATTERNS = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".claude",
];

const SKIP_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".ico", ".webp",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv",
  ".zip", ".tar", ".gz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".ttf", ".woff", ".woff2",
]);

const MAX_DEPTH = 20;

function shouldSkip(name: string): boolean {
  for (const pattern of SKIP_PATTERNS) {
    if (name === pattern) return true;
  }
  if (name.startsWith(".") && name !== ".env" && name !== ".env.local") return true;
  return false;
}

function readDirRecursive(
  absPath: string,
  relPath: string,
  depth: number,
): FileTreeNode[] {
  if (depth > MAX_DEPTH) return [];

  // withFileTypes：一次扫描即带回目录项类型（Windows 上来自 FindFirstFile 的
  // 属性位），省去对每个条目单独 statSync 的一次系统调用——大目录下提速 ~20x。
  let entries: Dirent[];
  try {
    entries = readdirSync(absPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: FileTreeNode[] = [];

  for (const ent of entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  )) {
    const name = ent.name;
    if (shouldSkip(name)) continue;

    const childRelPath = relPath ? `${relPath}/${name}` : name;

    let isDir: boolean;
    try {
      isDir = ent.isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      const children = readDirRecursive(join(absPath, name), childRelPath, depth + 1);
      result.push({ name, path: childRelPath, isDirectory: true, children });
    } else {
      const ext = name.includes(".")
        ? name.slice(name.lastIndexOf(".")).toLowerCase()
        : "";
      if (SKIP_EXTENSIONS.has(ext)) continue;
      result.push({ name, path: childRelPath, isDirectory: false });
    }
  }

  return result;
}

export function getFileTree(
  projectPath: string,
  projectId: string,
): FileTreeResult {
  const result: FileTreeResult = {
    projectPath,
    projectId,
    tree: [],
  };
  const safeBase = resolveWithin(projectPath, ".");
  if (!safeBase) {
    result.error = `项目路径 "${projectPath}" 不合法`;
    return result;
  }
  try {
    result.tree = readDirRecursive(safeBase, "", 0);
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

const LANG_MAP: Record<string, string> = {
  ".java": "java",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".xml": "markup",
  ".svg": "markup",
  ".html": "markup",
  ".htm": "markup",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".rs": "rust",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".env": "text",
  ".gitignore": "text",
};

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export function getFileContent(
  projectPath: string,
  filePath: string,
): FileContentResult {
  const ext = filePath.includes(".")
    ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
    : "";

  if (SKIP_EXTENSIONS.has(ext)) {
    return { projectPath, filePath, content: "", mimeType: "binary" };
  }

  const absPath = resolveWithin(projectPath, filePath);
  if (!absPath) {
    return { projectPath, filePath, content: "", mimeType: "text", error: "路径不合法：文件不在项目目录内" };
  }

  try {
    const stat = statSync(absPath);
    if (stat.size > MAX_FILE_SIZE) {
      return {
        projectPath,
        filePath,
        content: "",
        mimeType: "binary",
        error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 1MB 限制`,
      };
    }
  } catch (err) {
    return {
      projectPath,
      filePath,
      content: "",
      mimeType: "text",
      error: (err as Error).message,
    };
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (err) {
    return {
      projectPath,
      filePath,
      content: "",
      mimeType: "text",
      error: (err as Error).message,
    };
  }

  const lang = LANG_MAP[ext];
  if (lang === "markdown") {
    return { projectPath, filePath, content, mimeType: "markdown" };
  }
  if (ext === ".html" || ext === ".htm") {
    return { projectPath, filePath, content, mimeType: "html" };
  }
  if (lang && lang !== "text") {
    return { projectPath, filePath, content, mimeType: "code", language: lang };
  }
  return { projectPath, filePath, content, mimeType: "text" };
}
