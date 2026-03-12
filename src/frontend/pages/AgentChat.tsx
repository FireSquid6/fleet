import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { PaperAirplaneIcon } from "@heroicons/react/24/solid";
import { ArrowLeftIcon, ArrowTopRightOnSquareIcon, PlayIcon } from "@heroicons/react/24/outline";
import { OpenWorkspaceButton } from "../components/OpenWorkspaceButton";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { client } from "../client";
import ChatMessage, { type Message, type MessagePart, type ToolPart } from "../components/ChatMessage";
import TokenManager from "../components/TokenManager";
import InstructionsEditor from "../components/InstructionsEditor";

// ── Types ──────────────────────────────────────────────────────────────────────

type Tab = "chat" | "agent-file" | "skills" | "tokens";
type ConnectionState = "connecting" | "connected" | "error";

// ── Helpers ───────────────────────────────────────────────────────────────────

function historyToMessages(history: { role: "user" | "assistant"; parts: { type: string; text?: string; toolName?: string; input?: unknown; result?: unknown; error?: string }[] }[]): Message[] {
  return history.map((entry) => ({
    role: entry.role === "assistant" ? "agent" : "user",
    parts: entry.parts.map((p): MessagePart => {
      if (p.type === "text") return { type: "text", text: p.text! };
      if (p.type === "tool") return { type: "tool", toolName: p.toolName!, input: p.input, result: p.result };
      return { type: "error", error: p.error! };
    }),
  }));
}

// ── Tab content components ────────────────────────────────────────────────────

function AgentFileTab({ projectName, agentName }: { projectName: string; agentName: string }) {
  const { data: instructions, loading } = client.useListenedQuery("getAgentInstructions", { projectName, agentName });
  const [setAgentInstructions] = client.useMutation("setAgentInstructions");

  return (
    <div className="p-6">
      <InstructionsEditor
        content={instructions}
        loading={loading}
        onSave={(content) => setAgentInstructions({ projectName, agentName, content })}
      />
    </div>
  );
}

function SkillsTab({ projectName, agentName }: { projectName: string; agentName: string }) {
  const { data: skills, loading } = client.useQuery("getAgentSkills", { projectName, agentName });
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) return <div className="flex justify-center py-12"><span className="loading loading-spinner" /></div>;

  if (!skills?.length) {
    return (
      <div className="p-6 text-center text-base-content/40 italic text-sm py-16">
        No skills assigned to this agent.
      </div>
    );
  }

  return (
    <div className="p-6 space-y-3">
      {skills.map((skill) => (
        <div key={skill.name} className="border border-base-300 rounded-xl overflow-hidden">
          <button
            className="w-full flex items-start gap-3 px-4 py-3 bg-base-200 hover:bg-base-300 transition-colors text-left"
            onClick={() => setExpanded(expanded === skill.name ? null : skill.name)}
          >
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">{skill.title}</p>
              <p className="text-xs text-base-content/50 font-mono">{skill.name}</p>
              {skill.description && (
                <p className="text-sm text-base-content/60 mt-1">{skill.description}</p>
              )}
            </div>
            <span className="text-xs text-base-content/40 shrink-0 pt-0.5">
              {expanded === skill.name ? "▲" : "▼"}
            </span>
          </button>
          {expanded === skill.name && skill.content && (
            <div className="px-5 py-4 border-t border-base-300 bg-base-100">
              <div className="prose prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.content}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}


function TokensTab({ projectName, agentName }: { projectName: string; agentName: string }) {
  const { data: tokens, loading } = client.useListenedQuery("getAgentTokens", { projectName, agentName });

  const [setAgentToken] = client.useMutation("setAgentToken");
  const [deleteAgentToken] = client.useMutation("deleteAgentToken");
  const [setProjectToken] = client.useMutation("setProjectToken");
  const [deleteProjectToken] = client.useMutation("deleteProjectToken");
  const [setRootToken] = client.useMutation("setRootToken");
  const [deleteRootToken] = client.useMutation("deleteRootToken");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-3">Agent</h3>
        <TokenManager
          tokens={tokens?.agent}
          loading={loading}
          onSet={(name, value) => setAgentToken({ projectName, agentName, name, value })}
          onDelete={(name) => deleteAgentToken({ projectName, agentName, name })}
        />
      </div>
      <div>
        <h3 className="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-3">Project</h3>
        <TokenManager
          tokens={tokens?.project}
          loading={loading}
          onSet={(name, value) => setProjectToken({ projectName, name, value })}
          onDelete={(name) => deleteProjectToken({ projectName, name })}
        />
      </div>
      <div>
        <h3 className="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-3">Root</h3>
        <TokenManager
          tokens={tokens?.root}
          loading={loading}
          onSet={(name, value) => setRootToken({ name, value })}
          onDelete={(name) => deleteRootToken({ name })}
        />
      </div>
    </div>
  );
}

// ── Chat tab ──────────────────────────────────────────────────────────────────

function ChatTab({
  connectionState,
  connectionError,
  messages,
  streamingMessage,
  input,
  isSending,
  onInput,
  onSend,
  onKeyDown,
  onStart,
  isStarting,
  bottomRef,
}: {
  connectionState: ConnectionState;
  connectionError: string;
  messages: Message[];
  streamingMessage: Message | null;
  input: string;
  isSending: boolean;
  onInput: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onStart: () => void;
  isStarting: boolean;
  bottomRef: React.RefObject<HTMLDivElement | null>;
}) {
  const allMessages = streamingMessage ? [...messages, streamingMessage] : messages;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {connectionState === "error" && (
        <div className="alert alert-error rounded-none border-x-0 border-t-0 flex items-center justify-between shrink-0">
          <span>{connectionError || "Could not connect to agent. Make sure it is running."}</span>
          <button
            className="btn btn-sm btn-neutral gap-1.5 shrink-0"
            onClick={onStart}
            disabled={isStarting}
          >
            {isStarting ? <span className="loading loading-spinner loading-xs" /> : <PlayIcon className="w-4 h-4" />}
            Start Agent
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
        {allMessages.length === 0 && connectionState === "connected" && (
          <div className="flex items-center justify-center h-full text-base-content/30 text-sm italic">
            Send a message to start the conversation
          </div>
        )}
        {allMessages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="px-4 py-3 border-t border-base-300 bg-base-100 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            className="textarea textarea-bordered flex-1 resize-none min-h-[2.75rem] max-h-40"
            placeholder={
              connectionState === "connected"
                ? "Message agent… (Enter to send, Shift+Enter for newline)"
                : "Waiting for connection…"
            }
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={connectionState !== "connected" || isSending}
            rows={1}
          />
          <button
            className="btn btn-primary btn-square shrink-0"
            onClick={onSend}
            disabled={!input.trim() || connectionState !== "connected" || isSending}
            title="Send"
          >
            {isSending
              ? <span className="loading loading-spinner loading-sm" />
              : <PaperAirplaneIcon className="w-5 h-5" />
            }
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AgentChat() {
  const { projectName, agentName } = useParams<{ projectName: string; agentName: string }>();

  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string>("");
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const tokenRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const params = { projectName: projectName!, agentName: agentName! };
  const [startAgent, { loading: isStarting }] = client.useMutation("startAgent");

  useEffect(() => {
    let active = true;
    let unsub: (() => void) | null = null;

    const connect = async () => {
      setConnectionState("connecting");
      setConnectionError("");

      const result = await client.connect("agentSession", params, {});
      if (!active) return;

      if (!result.success) {
        setConnectionState("error");
        setConnectionError(result.error.message);
        return;
      }

      tokenRef.current = result.token;

      const historyResult = await client.query("getAgentHistory", params);
      if (active && historyResult.success && historyResult.data.length > 0) {
        setMessages(historyToMessages(historyResult.data));
      }

      unsub = await client.subscribe("agentSession", params, result.token, (msg) => {
        if (!active) return;

        if (msg.type === "text") {
          setStreamingMessage((prev) => {
            if (!prev) return { role: "agent", parts: [{ type: "text", text: msg.text }], isStreaming: true };
            const parts = [...prev.parts];
            const last = parts[parts.length - 1];
            if (last?.type === "text") {
              parts[parts.length - 1] = { type: "text", text: last.text + msg.text };
            } else {
              parts.push({ type: "text", text: msg.text });
            }
            return { ...prev, parts };
          });
        } else if (msg.type === "tool-call") {
          setStreamingMessage((prev) => {
            const newPart: ToolPart = { type: "tool", toolName: msg.toolName, input: msg.input };
            if (!prev) return { role: "agent", parts: [newPart], isStreaming: true };
            return { ...prev, parts: [...prev.parts, newPart] };
          });
        } else if (msg.type === "tool-result") {
          setStreamingMessage((prev) => {
            if (!prev) return prev;
            const parts = prev.parts.map<MessagePart>((p) => {
              if (p.type === "tool" && p.toolName === msg.toolName && p.result === undefined) {
                return { ...p, result: msg.result };
              }
              return p;
            });
            return { ...prev, parts };
          });
        } else if (msg.type === "error") {
          setStreamingMessage((prev) => {
            const errorPart: MessagePart = { type: "error", error: msg.error };
            if (!prev) return { role: "agent", parts: [errorPart], isStreaming: true };
            return { ...prev, parts: [...prev.parts, errorPart] };
          });
        } else if (msg.type === "done") {
          setStreamingMessage((prev) => {
            if (prev && prev.parts.length > 0) {
              setMessages((msgs) => [...msgs, { ...prev, isStreaming: false }]);
            }
            setIsSending(false);
            return null;
          });
        }
      });

      if (active) setConnectionState("connected");
    };

    connect();
    return () => {
      active = false;
      unsub?.();
      tokenRef.current = null;
    };
  }, [projectName, agentName, retryCount]);

  useEffect(() => {
    if (activeTab === "chat") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingMessage, activeTab]);

  const handleStart = useCallback(async () => {
    await startAgent(params);
    setRetryCount((c) => c + 1);
  }, [projectName, agentName]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || !tokenRef.current || isSending || connectionState !== "connected") return;

    setInput("");
    setIsSending(true);
    setMessages((msgs) => [...msgs, { role: "user", parts: [{ type: "text", text }] }]);
    setStreamingMessage({ role: "agent", parts: [], isStreaming: true });

    await client.send("agentSession", params, tokenRef.current, { type: "input", text });
  }, [input, isSending, connectionState, projectName, agentName]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "agent-file", label: "AGENT File" },
    { id: "skills", label: "Skills" },
    { id: "tokens", label: "Tokens" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-base-300 bg-base-100 flex items-center gap-3 shrink-0">
        <Link
          to={`/projects/${projectName}`}
          className="btn btn-ghost btn-sm btn-square"
          title="Back to project"
        >
          <ArrowLeftIcon className="w-4 h-4" />
        </Link>
        <div>
          <h2 className="text-lg font-bold leading-tight">{agentName}</h2>
          <p className="text-xs text-base-content/50">{projectName}</p>
        </div>
        <OpenWorkspaceButton agent={agentName ?? ""} project={projectName ?? ""} />
        <div className="ml-auto flex items-center gap-2">
          {connectionState === "connecting" && (
            <span className="flex items-center gap-1.5 text-xs text-base-content/50">
              <span className="loading loading-spinner loading-xs" />
              Connecting…
            </span>
          )}
          {connectionState === "connected" && (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="w-2 h-2 rounded-full bg-success inline-block" />
              Connected
            </span>
          )}
          {connectionState === "error" && (
            <span className="flex items-center gap-1.5 text-xs text-error">
              <span className="w-2 h-2 rounded-full bg-error inline-block" />
              Disconnected
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-base-300 bg-base-100 shrink-0">
        <div className="flex px-6 gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-base-content/50 hover:text-base-content"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "chat" ? (
        <ChatTab
          connectionState={connectionState}
          connectionError={connectionError}
          messages={messages}
          streamingMessage={streamingMessage}
          input={input}
          isSending={isSending}
          onInput={setInput}
          onSend={sendMessage}
          onKeyDown={handleKeyDown}
          onStart={handleStart}
          isStarting={isStarting}
          bottomRef={bottomRef}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {activeTab === "agent-file" && (
            <AgentFileTab projectName={projectName!} agentName={agentName!} />
          )}
          {activeTab === "skills" && (
            <SkillsTab projectName={projectName!} agentName={agentName!} />
          )}
          {activeTab === "tokens" && (
            <TokensTab projectName={projectName!} agentName={agentName!} />
          )}
        </div>
      )}
    </div>
  );
}
