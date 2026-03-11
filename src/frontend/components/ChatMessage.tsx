import { useState } from "react";
import { ChevronRightIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export type TextPart = { type: "text"; text: string };
export type ToolPart = { type: "tool"; toolName: string; input: unknown; result?: unknown };
export type ErrorPart = { type: "error"; error: string };
export type MessagePart = TextPart | ToolPart | ErrorPart;

export interface Message {
  role: "user" | "agent";
  parts: MessagePart[];
  isStreaming?: boolean;
}

function ToolBlock({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const hasResult = part.result !== undefined;

  return (
    <div className="my-1 rounded-lg border border-base-300 overflow-hidden text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-base-200 hover:bg-base-300 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDownIcon className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="w-3 h-3 shrink-0" />
        )}
        <span className="font-mono font-medium text-base-content/70">{part.toolName}</span>
        {!hasResult && (
          <span className="ml-auto loading loading-dots loading-xs" />
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 bg-base-100 font-mono space-y-2 border-t border-base-300">
          <div>
            <p className="text-base-content/40 mb-1 uppercase tracking-wider text-[10px]">Input</p>
            <pre className="whitespace-pre-wrap text-base-content/80 text-xs">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          </div>
          {hasResult && (
            <div>
              <p className="text-base-content/40 mb-1 uppercase tracking-wider text-[10px]">Result</p>
              <pre className="whitespace-pre-wrap text-base-content/80 text-xs">
                {JSON.stringify(part.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div className={`chat ${isUser ? "chat-end" : "chat-start"}`}>
      <div className="chat-header mb-1 text-xs text-base-content/50">
        {isUser ? "You" : "Agent"}
      </div>
      <div
        className={`chat-bubble max-w-[75%] ${
          isUser ? "chat-bubble-primary" : "bg-base-200 text-base-content"
        }`}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            const isLastPart = i === message.parts.length - 1;
            return (
              <div key={i} className="prose prose-sm max-w-none leading-relaxed [&_pre]:!p-0 [&_pre]:!m-0 [&_pre]:!bg-transparent">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children }) {
                      const match = /language-(\w+)/.exec(className ?? "");
                      if (match) {
                        return (
                          <SyntaxHighlighter
                            style={oneDark}
                            language={match[1]}
                            PreTag="div"
                            customStyle={{ borderRadius: "0.5rem", fontSize: "0.8rem", margin: "0.5rem 0" }}
                          >
                            {String(children).replace(/\n$/, "")}
                          </SyntaxHighlighter>
                        );
                      }
                      return (
                        <code className="bg-base-300 text-base-content px-1 py-0.5 rounded text-xs font-mono">
                          {children}
                        </code>
                      );
                    },
                  }}
                >
                  {message.isStreaming && isLastPart ? part.text + "\u200B" : part.text}
                </ReactMarkdown>
                {message.isStreaming && isLastPart && (
                  <span className="inline-block w-1.5 h-4 ml-0.5 bg-current opacity-70 animate-pulse align-middle" />
                )}
              </div>
            );
          }
          if (part.type === "tool") {
            return <ToolBlock key={i} part={part} />;
          }
          if (part.type === "error") {
            return (
              <p key={i} className="text-error text-sm">
                Error: {part.error}
              </p>
            );
          }
          return null;
        })}
        {message.isStreaming && message.parts.length === 0 && (
          <span className="loading loading-dots loading-sm" />
        )}
      </div>
    </div>
  );
}
