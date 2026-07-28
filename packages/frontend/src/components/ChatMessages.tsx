import { useRef, useEffect, useState } from "react";
import type { AllMessage } from "../types";
import {
  isChatMessage,
  isSystemMessage,
  isToolMessage,
  isToolResultMessage,
  isPlanMessage,
  isThinkingMessage,
  isTodoMessage,
} from "../types";
import {
  ChatMessageComponent,
  SystemMessageComponent,
  ToolMessageComponent,
  ToolResultMessageComponent,
  PlanMessageComponent,
  ThinkingMessageComponent,
  TodoMessageComponent,
  LoadingComponent,
} from "./MessageComponents";
// import { UI_CONSTANTS } from "../utils/constants"; // Unused for now

interface ChatMessagesProps {
  messages: AllMessage[];
  isLoading: boolean;
  /** 历史分页加载中（顶部显示"加载更早的历史"提示） */
  isHistoryLoading?: boolean;
}

export function ChatMessages({ messages, isLoading, isHistoryLoading }: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const userScrolledUpRef = useRef(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [scrolledDown, setScrolledDown] = useState(false);

  const scrollToTop = () => {
    messagesContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToBottom = (force = false) => {
    if (force) userScrolledUpRef.current = false;
    if (userScrolledUpRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleScroll = () => {
    const c = messagesContainerRef.current;
    if (!c) return;
    const fromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    userScrolledUpRef.current = fromBottom > 80;
    setNearBottom(fromBottom < 80);
    setScrolledDown(c.scrollTop > 400);
  };

  // Auto-scroll when messages change (skip if user is reading history)
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Always scroll to bottom when AI starts generating
  useEffect(() => {
    if (isLoading) scrollToBottom(true);
  }, [isLoading]);

  // 预计算稳定 key：type+timestamp+同组出现次号。不用数组 index——分页 prepend 更早
  // 历史时 index 会变，导致已渲染消息重 mount（Markdown 重渲染 → 闪烁）。
  // 同组次号由 processor 输出顺序决定，prepend 不影响（新页 timestamp 不同，不进同组）。
  const messageKeys = (() => {
    const counters = new Map<string, number>();
    return messages.map((m) => {
      const base = `${m.type}-${m.timestamp}`;
      const n = counters.get(base) ?? 0;
      counters.set(base, n + 1);
      return `${base}-${n}`;
    });
  })();

  const renderMessage = (message: AllMessage, index: number) => {
    const key = messageKeys[index];

    if (isSystemMessage(message)) {
      return <SystemMessageComponent key={key} message={message} />;
    } else if (isToolMessage(message)) {
      return <ToolMessageComponent key={key} message={message} />;
    } else if (isToolResultMessage(message)) {
      return <ToolResultMessageComponent key={key} message={message} />;
    } else if (isPlanMessage(message)) {
      return <PlanMessageComponent key={key} message={message} />;
    } else if (isThinkingMessage(message)) {
      return <ThinkingMessageComponent key={key} message={message} />;
    } else if (isTodoMessage(message)) {
      return <TodoMessageComponent key={key} message={message} />;
    } else if (isChatMessage(message)) {
      return <ChatMessageComponent key={key} message={message} />;
    }
    return null;
  };

  return (
    <div
      ref={messagesContainerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto bg-white/70 dark:bg-slate-800/70 border border-slate-200/60 dark:border-slate-700/60 p-3 sm:p-6 mb-3 sm:mb-6 rounded-2xl shadow-sm backdrop-blur-sm flex flex-col"
    >
      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="flex-1" aria-hidden="true"></div>
          {isHistoryLoading && (
            <div className="flex justify-center py-2 text-xs text-slate-400 dark:text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 border-2 border-slate-300 dark:border-slate-600 border-t-transparent rounded-full animate-spin" />
                正在加载更早的历史…
              </span>
            </div>
          )}
          {messages.map(renderMessage)}
          {isLoading && <LoadingComponent />}
          <div ref={messagesEndRef} />
          {!nearBottom && (
            <div className="sticky bottom-0 flex justify-end py-2 pointer-events-none">
              <div className="flex flex-col gap-1.5 pointer-events-auto">
                {scrolledDown && (
                  <button onClick={scrollToTop} title="回到顶部"
                    className="w-8 h-8 rounded-full bg-white/80 dark:bg-slate-700/80 backdrop-blur border border-slate-200/60 dark:border-slate-600/60 shadow flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-blue-500 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-600 transition-all">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 10l4-4 4 4"/></svg>
                  </button>
                )}
                <button onClick={() => scrollToBottom(true)} title="回到底部"
                  className="w-8 h-8 rounded-full bg-white/80 dark:bg-slate-700/80 backdrop-blur border border-slate-200/60 dark:border-slate-600/60 shadow flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-blue-500 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-600 transition-all">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6l4 4 4-4"/></svg>
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-center text-slate-500 dark:text-slate-400">
      <div>
        <div className="text-6xl mb-6 opacity-60">
          <span role="img" aria-label="chat icon">
            💬
          </span>
        </div>
        <p className="text-lg font-medium">Start a conversation with Claude</p>
        <p className="text-sm mt-2 opacity-80">
          Type your message below to begin
        </p>
      </div>
    </div>
  );
}
