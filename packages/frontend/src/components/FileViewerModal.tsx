import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import ts from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import js from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import { MarkdownRenderer } from "./MarkdownRenderer";

SyntaxHighlighter.registerLanguage("typescript", ts);
SyntaxHighlighter.registerLanguage("javascript", js);
SyntaxHighlighter.registerLanguage("java", java);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("scss", scss);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("c", c);
SyntaxHighlighter.registerLanguage("cpp", cpp);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("toml", toml);
SyntaxHighlighter.registerLanguage("ini", ini);

interface FileViewerModalProps {
  isOpen: boolean;
  filePath: string;
  content: string;
  mimeType: "markdown" | "html" | "code" | "text" | "binary";
  language?: string;
  onClose: () => void;
}

function getTypeBadge(mimeType: string) {
  switch (mimeType) {
    case "markdown":
      return { label: "Markdown", color: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" };
    case "html":
      return { label: "HTML", color: "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300" };
    case "code":
      return { label: "Code", color: "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300" };
    case "text":
      return { label: "Text", color: "bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400" };
    default:
      return { label: "Binary", color: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300" };
  }
}

export function FileViewerModal({ isOpen, filePath, content, mimeType, language, onClose }: FileViewerModalProps) {
  if (!isOpen) return null;

  const badge = getTypeBadge(mimeType);
  const trimmed = content?.trim() ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl w-[90vw] max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-sm text-slate-700 dark:text-slate-200 truncate">
              {filePath}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${badge.color}`}>
              {badge.label}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {!trimmed ? (
            <div className="px-4 py-8 text-sm text-slate-400 text-center">
              文件内容为空
            </div>
          ) : mimeType === "binary" ? (
            <div className="px-4 py-8 text-sm text-slate-400 text-center">
              无法预览二进制文件
            </div>
          ) : mimeType === "markdown" ? (
            <div className="p-4">
              <MarkdownRenderer content={content} />
            </div>
          ) : mimeType === "html" ? (
            <iframe
              className="w-full flex-1 border-0"
              style={{ height: "calc(85vh - 52px)" }}
              sandbox="allow-scripts"
              srcDoc={content}
              title={filePath}
            />
          ) : mimeType === "code" ? (
            <SyntaxHighlighter
              language={language || "text"}
              style={vscDarkPlus}
              customStyle={{
                margin: 0,
                padding: "16px",
                borderRadius: 0,
                fontSize: "13px",
                lineHeight: "1.5",
                minHeight: "100%",
              }}
              showLineNumbers
            >
              {content}
            </SyntaxHighlighter>
          ) : (
            <pre className="font-mono text-sm p-4 whitespace-pre-wrap text-slate-700 dark:text-slate-300">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
