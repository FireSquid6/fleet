import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/solid";
import { covenantClient } from "../client";

// ── session entry types ──────────────────────────────────────────────────────

type UserMessage = { type: "user"; timestamp: string; content: string };
type AssistantMessage = { type: "assistant"; content: string };
type ToolEntry = {
  type: "tool";
  tool: string;
  label: string;
  input?: string;
  output: string;
  isError?: boolean;
  duration: string;
  running?: boolean;
};
type SessionEntry = UserMessage | AssistantMessage | ToolEntry;

type AgentSession = {
  status: "idle" | "running" | "error";
  entries: SessionEntry[];
};

// ── mock session data ────────────────────────────────────────────────────────

const MOCK_SESSIONS: Record<string, AgentSession> = {
  "agent-1": {
    status: "idle",
    entries: [
      {
        type: "user",
        timestamp: "10:23:01",
        content: "Set up a GitHub Actions CI pipeline that runs tests on every PR and push to main.",
      },
      {
        type: "assistant",
        content:
          "I'll set up the CI pipeline. Let me start by exploring the project structure.",
      },
      {
        type: "tool",
        tool: "Bash",
        label: "ls -la",
        input: "ls -la",
        output:
          "total 56\ndrwxr-xr-x  9 user user 4096 Feb 25 10:20 .\n-rw-r--r--  1 user user  531 Feb 25 10:18 package.json\n-rw-r--r--  1 user user  198 Feb 24 18:40 tsconfig.json\ndrwxr-xr-x  5 user user 4096 Feb 25 10:20 src\ndrwxr-xr-x  2 user user 4096 Feb 24 18:40 .github\n-rw-r--r--  1 user user 3941 Feb 25 10:20 bun.lock",
        duration: "0.08s",
      },
      {
        type: "tool",
        tool: "Read",
        label: "package.json",
        input: "package.json",
        output:
          '{\n  "name": "fleet",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "dev": "bun --hot src/index.ts",\n    "start": "NODE_ENV=production bun src/index.ts",\n    "test": "bun test"\n  },\n  "dependencies": {\n    "react": "^19",\n    "zod": "^4.3.6"\n  }\n}',
        duration: "0.03s",
      },
      {
        type: "tool",
        tool: "Glob",
        label: ".github/workflows/*.yml",
        input: ".github/workflows/*.yml",
        output: "(no matches — no existing workflows)",
        duration: "0.02s",
      },
      {
        type: "assistant",
        content:
          "This is a Bun + TypeScript project with no existing workflows. I'll create a CI workflow that:\n\n1. Triggers on `pull_request` and `push` to `main`\n2. Sets up Bun\n3. Caches `node_modules`\n4. Runs `bun test`",
      },
      {
        type: "tool",
        tool: "Bash",
        label: "mkdir -p .github/workflows",
        input: "mkdir -p .github/workflows",
        output: "",
        duration: "0.06s",
      },
      {
        type: "tool",
        tool: "Write",
        label: ".github/workflows/ci.yml",
        input: ".github/workflows/ci.yml",
        output: `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Type check
        run: bunx tsc --noEmit
      - name: Run tests
        run: bun test`,
        duration: "0.04s",
      },
      {
        type: "tool",
        tool: "Bash",
        label: "bun test",
        input: "bun test",
        output:
          "bun test v1.3.5\n\n  src/backend/implementations/projects.test.ts:\n  ✓ getProjects returns all projects [2ms]\n  ✓ getProject returns project by id [1ms]\n  ✓ getProject returns 404 for unknown id [1ms]\n\n  src/backend/implementations/tasks.test.ts:\n  ✓ getProjectTasks filters by projectId [1ms]\n\n4 tests passed [43ms]",
        duration: "1.24s",
      },
      {
        type: "assistant",
        content:
          "All 4 tests pass. The CI pipeline is live — any PR or push to `main` will now run the full test suite. Task complete.",
      },
    ],
  },

  "agent-2": {
    status: "running",
    entries: [
      {
        type: "user",
        timestamp: "11:47:33",
        content:
          "Write integration tests for the covenant API procedures covering happy paths and error cases.",
      },
      {
        type: "assistant",
        content:
          "I'll write integration tests for all six covenant procedures. Let me first read the implementations to understand the data shapes and error conditions.",
      },
      {
        type: "tool",
        tool: "Glob",
        label: "src/**/*.ts",
        input: "src/**/*.ts",
        output:
          "src/index.ts\nsrc/covenant.ts\nsrc/backend/index.ts\nsrc/backend/server.ts\nsrc/backend/implementations/projects.ts\nsrc/backend/implementations/tasks.ts\nsrc/backend/implementations/agents.ts\nsrc/frontend/client.ts",
        duration: "0.04s",
      },
      {
        type: "tool",
        tool: "Read",
        label: "src/covenant.ts",
        input: "src/covenant.ts",
        output: `import { declareCovenant, query, mutation } from "@covenant-rpc/core";
import { z } from "zod";

const ProjectSchema = z.object({ id, name, repoUrl, dockerImage, subdirectory? });
const TaskSchema    = z.object({ id, title, status, assignedAgentId? });
const AgentSchema   = z.object({ id, name, model, tools, projectId });

export const covenant = declareCovenant({
  procedures: {
    getProjects:     query({ input: z.null(), output: z.array(ProjectSchema) }),
    getProject:      query({ input: z.object({ id: z.string() }), output: ProjectSchema }),
    createProject:   mutation({ ... }),
    getProjectTasks: query({ input: z.object({ projectId: z.string() }), output: z.array(TaskSchema) }),
    getProjectAgents:query({ input: z.object({ projectId: z.string() }), output: z.array(AgentSchema) }),
    createAgent:     mutation({ ... }),
  },
  channels: {},
});`,
        duration: "0.03s",
      },
      {
        type: "tool",
        tool: "Read",
        label: "src/backend/implementations/projects.ts",
        input: "src/backend/implementations/projects.ts",
        output: `const dummyProjects = [
  { id: "proj-1", name: "fleet", repoUrl: "https://github.com/example/fleet", dockerImage: "node:20" },
  { id: "proj-2", name: "api-gateway", repoUrl: "...", dockerImage: "python:3.12", subdirectory: "backend" },
];

server.defineProcedure("getProject", {
  procedure: ({ inputs, error }) => {
    const project = dummyProjects.find((p) => p.id === inputs.id);
    if (!project) error("Project not found", 404);
    return project!;
  },
});`,
        duration: "0.03s",
      },
      {
        type: "assistant",
        content:
          "Clear picture of the implementations. I'll use `directClientToServer` so tests run without an HTTP server — no port binding, no teardown needed. Writing projects tests first.",
      },
      {
        type: "tool",
        tool: "Write",
        label: "src/backend/implementations/projects.test.ts",
        input: "src/backend/implementations/projects.test.ts",
        output: `import { test, expect } from "bun:test";
import { CovenantClient } from "@covenant-rpc/client";
import { directClientToServer } from "@covenant-rpc/server/interfaces/direct";
import { emptyClientToSidekick } from "@covenant-rpc/client/interfaces/empty";
import { server } from "../server";
import { covenant } from "../../covenant";

const client = new CovenantClient(covenant, {
  serverConnection: directClientToServer(server, {}),
  sidekickConnection: emptyClientToSidekick(),
});

test("getProjects returns all projects", async () => {
  const result = await client.query("getProjects", null);
  expect(result.success).toBe(true);
  expect(result.data).toHaveLength(2);
});

test("getProject returns project by id", async () => {
  const result = await client.query("getProject", { id: "proj-1" });
  expect(result.success).toBe(true);
  expect(result.data.name).toBe("fleet");
});

test("getProject returns 404 for unknown id", async () => {
  const result = await client.query("getProject", { id: "does-not-exist" });
  expect(result.success).toBe(false);
  expect(result.error.code).toBe(404);
});`,
        duration: "0.05s",
      },
      {
        type: "tool",
        tool: "Bash",
        label: "bun test src/backend/implementations/projects.test.ts",
        input: "bun test src/backend/implementations/projects.test.ts",
        output:
          "bun test v1.3.5\n\n  src/backend/implementations/projects.test.ts:\n  ✓ getProjects returns all projects [3ms]\n  ✓ getProject returns project by id [1ms]\n  ✓ getProject returns 404 for unknown id [1ms]\n\n3 tests passed [51ms]",
        duration: "2.17s",
      },
      {
        type: "assistant",
        content: "Projects tests pass. Now writing tests for tasks and agents.",
      },
      {
        type: "tool",
        tool: "Write",
        label: "src/backend/implementations/tasks.test.ts",
        input: "",
        output: "",
        duration: "",
        running: true,
      },
    ],
  },
};

// ── sub-components ───────────────────────────────────────────────────────────

const TOOL_BADGE: Record<string, string> = {
  Bash:  "badge-neutral",
  Read:  "badge-info",
  Write: "badge-success",
  Edit:  "badge-success",
  Grep:  "badge-warning",
  Glob:  "badge-secondary",
};

function ToolBlock({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-base-300 text-sm font-mono overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 bg-base-200 hover:bg-base-300 transition-colors text-left"
        onClick={() => !entry.running && setOpen((o) => !o)}
        disabled={entry.running}
      >
        <span className={`badge ${TOOL_BADGE[entry.tool] ?? "badge-neutral"} badge-sm shrink-0`}>
          {entry.tool}
        </span>
        <span className="text-base-content/70 truncate flex-1">{entry.label}</span>
        {entry.running ? (
          <span className="loading loading-dots loading-xs opacity-60" />
        ) : (
          <>
            <span className={`text-xs shrink-0 ${entry.isError ? "text-error" : "text-success"}`}>
              {entry.isError ? "✗" : "✓"} {entry.duration}
            </span>
            {open
              ? <ChevronDownIcon className="h-3.5 w-3.5 text-base-content/40 shrink-0" />
              : <ChevronRightIcon className="h-3.5 w-3.5 text-base-content/40 shrink-0" />
            }
          </>
        )}
      </button>

      {open && (
        <div className="border-t border-base-300 bg-base-300/40">
          {entry.input && (
            <div className="px-3 pt-2 pb-1 border-b border-base-300/60">
              <p className="text-[10px] text-base-content/40 uppercase tracking-widest mb-1">Input</p>
              <pre className="text-xs whitespace-pre-wrap text-base-content/80">{entry.input}</pre>
            </div>
          )}
          <div className="px-3 pt-2 pb-3">
            <p className="text-[10px] text-base-content/40 uppercase tracking-widest mb-1">Output</p>
            <pre className={`text-xs whitespace-pre-wrap ${entry.isError ? "text-error" : "text-base-content/80"}`}>
              {entry.output || "(no output)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function UserMessage({ entry }: { entry: UserMessage }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="avatar placeholder shrink-0 mt-0.5">
        <div className="bg-primary text-primary-content rounded-full w-6 text-xs flex items-center justify-center font-bold">
          U
        </div>
      </div>
      <div className="flex-1">
        <p className="text-xs text-base-content/40 mb-1">{entry.timestamp}</p>
        <p className="text-sm">{entry.content}</p>
      </div>
    </div>
  );
}

function AssistantMessage({ entry }: { entry: AssistantMessage }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="avatar placeholder shrink-0 mt-0.5">
        <div className="bg-secondary text-secondary-content rounded-full w-6 text-xs flex items-center justify-center font-bold">
          A
        </div>
      </div>
      <p className="text-sm whitespace-pre-wrap flex-1">{entry.content}</p>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

const STATUS_INDICATOR: Record<string, React.ReactNode> = {
  idle:    <span className="inline-block w-2 h-2 rounded-full bg-success" />,
  running: <span className="inline-block w-2 h-2 rounded-full bg-warning animate-pulse" />,
  error:   <span className="inline-block w-2 h-2 rounded-full bg-error" />,
};
const STATUS_LABEL: Record<string, string> = {
  idle: "Idle", running: "Running", error: "Error",
};

export default function AgentSession() {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>();

  const { data: projectData } = covenantClient.useQuery("getProject", { id: projectId! });
  const { data: agentsData }  = covenantClient.useQuery("getProjectAgents", { projectId: projectId! });

  const agent   = agentsData?.find((a) => a.id === agentId);
  const session = MOCK_SESSIONS[agentId!];

  if (!agent) {
    return <div className="p-8 text-base-content/40">Agent not found.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <div className="border-b border-base-300 px-8 py-4 shrink-0">
        <div className="text-xs text-base-content/40 mb-2 flex gap-1 items-center">
          <Link to={`/project/${projectId}`} className="hover:text-base-content transition-colors">
            {projectData?.name ?? projectId}
          </Link>
          <span>/</span>
          <Link to={`/project/${projectId}/agents`} className="hover:text-base-content transition-colors">
            Agents
          </Link>
          <span>/</span>
          <span className="text-base-content/70">{agent.name}</span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-bold">{agent.name}</h1>
          <span className="badge badge-neutral">{agent.model}</span>
          {session && (
            <span className="flex items-center gap-1.5 text-sm text-base-content/60">
              {STATUS_INDICATOR[session.status]}
              {STATUS_LABEL[session.status]}
            </span>
          )}
          <div className="flex gap-1 ml-auto">
            {agent.tools.map((t) => (
              <span key={t} className="badge badge-outline badge-sm">{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* session feed */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {!session ? (
          <p className="text-base-content/40 text-sm">No session history.</p>
        ) : (
          <div className="flex flex-col gap-4 max-w-3xl">
            {session.entries.map((entry, i) => {
              if (entry.type === "user")      return <UserMessage      key={i} entry={entry} />;
              if (entry.type === "assistant") return <AssistantMessage key={i} entry={entry} />;
              if (entry.type === "tool")      return <ToolBlock        key={i} entry={entry} />;
            })}

            {session.status === "running" && (
              <div className="flex gap-3 items-center text-sm text-base-content/40">
                <span className="loading loading-dots loading-sm" />
                Agent is working…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
