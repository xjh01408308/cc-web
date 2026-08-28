import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from "react";

interface ChatInputProps {
  isLoading: boolean;
  onSubmit: (text: string) => void;
  onAbort: () => void;
}

export function ChatInput({ isLoading, onSubmit, onAbort }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isLoading) return;
    onSubmit(text);
    setInput("");
  }, [input, isLoading, onSubmit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape" && isLoading) {
        e.preventDefault();
        onAbort();
      }
    },
    [handleSend, isLoading, onAbort],
  );

  return (
    <div className="flex-shrink-0 bg-white/80 dark:bg-slate-800/80 border-t border-slate-200 dark:border-slate-700 p-3 rounded-b-2xl">
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isLoading ? "Claude 正在回复..." : "输入消息 (Enter 发送, Shift+Enter 换行)"}
          disabled={isLoading}
          className="flex-1 px-4 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 resize-none max-h-40 overflow-y-auto"
        />
        {isLoading ? (
          <button
            onClick={onAbort}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
          >
            Esc 终止
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
