# Project Architecture

Fleet is an AI agent management UI. Users create **Projects** (a repo + Docker image), assign **Agents** to them, and track work on a **Kanban board** (tasks with statuses: `todo`, `in-progress`, `done`). Each agent has a **session page** showing a live Claude Code-style log of tool use.

## Routes

| Path | Component |
|------|-----------|
| `/` | Home |
| `/project/:projectId` | Project (Board tab) |
| `/project/:projectId/agents` | ProjectAgents (Agents tab) |
| `/project/:projectId/agents/:agentId` | AgentSession |
| `/new-project` | NewProject |
| `/armory` | Armory |

## Data Model (src/covenant.ts)

```typescript
ProjectSchema = { id, name, repoUrl, dockerImage, subdirectory? }
TaskSchema    = { id, title, status: "todo"|"in-progress"|"done", assignedAgentId? }
AgentSchema   = { id, name, model, tools: string[], projectId }
```

Procedures: `getProjects`, `getProject`, `createProject`, `getProjectTasks`, `getProjectAgents`, `createAgent`.

All backend data is currently **dummy in-memory arrays** in `src/backend/implementations/`. Replace these with real persistence when implementing actual agent execution.

## Key Frontend Patterns

- **`covenantClient`** is a `CovenantReactClient` exported from `src/frontend/client.ts`. Import it into every page/component that needs data.
- The client URL is built from `window.location` to avoid CORS issues: `${window.location.protocol}//${window.location.host}/api/covenant`.
- Use `useCachedQuery` for data shared across components (e.g. project list in Sidebar and Home). Use `useQuery` for page-specific data.
- The `useQuery` return value can be `null` (not just `undefined`) — always use `?? []` not `= []` destructuring default when the result feeds an array prop.

## Task/Agent UI Details

- **Project.tsx** merges API tasks with a `MOCK_EXTRA` map (descriptions, plans, agent assignment overrides). When replacing dummy data with real backend, remove `MOCK_EXTRA` and add `description`/`plan` fields to `TaskSchema`.
- **AgentSession.tsx** contains `MOCK_SESSIONS` keyed by `agentId`. This is the entire session log mock — replace with a real covenant channel or streaming endpoint when implementing Docker execution.
- In-progress tasks are expected to always have an `assignedAgentId`. The UI enforces this visually but not as a hard constraint.
- Agent name badges on kanban cards are `NavLink`s to the agent session page. `e.stopPropagation()` prevents the task detail modal from opening when clicking the badge.

# General Guidelines
- This project uses daisyUI for the frontend
- Put frontend logic in src/frontend and backend logic in src/backend
- This project uses covenant for the API communication layer. Details on covenant are below
- When writing code, only write comments to explain *why* a piece of code is doing what it does. Don't write comments simply explaining what the code does
- Prefer double quotes to single quotes
- Don't repeat yourself. Split common frontend elements into reusable components 

# Bun Information
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```


# Covenant-RPC Usage Guide

This guide covers patterns and APIs for working with the covenant-rpc framework.

## Quick Start Pattern

A complete covenant setup has three parts: declaration, server, and client.

```typescript
// 1. COVENANT DECLARATION (shared file - e.g., covenant.ts)
import { declareCovenant, query, mutation, channel } from "@covenant-rpc/core";
import { z } from "zod";

export const covenant = declareCovenant({
  procedures: {
    getTodos: query({
      input: z.null(),
      output: z.array(z.object({ id: z.number(), title: z.string() })),
    }),
    addTodo: mutation({
      input: z.object({ title: z.string() }),
      output: z.object({ id: z.number(), title: z.string() }),
    }),
  },
  channels: {},
});

// 2. SERVER IMPLEMENTATION (backend - e.g., api/covenant/route.ts)
import { CovenantServer } from "@covenant-rpc/server";
import { emptyServerToSidekick } from "@covenant-rpc/server/interfaces/empty";

const server = new CovenantServer(covenant, {
  contextGenerator: async (i) => ({ userId: getUserFromRequest(i.request) }),
  derivation: async (i) => ({
    forceAuth: () => {
      if (!i.ctx.userId) i.error("Not authenticated", 401);
      return i.ctx.userId;
    },
  }),
  sidekickConnection: emptyServerToSidekick(),
});

server.defineProcedure("getTodos", {
  resources: ({ ctx }) => [`user/${ctx.userId}/todos`],
  procedure: async ({ derived }) => {
    const userId = derived.forceAuth();
    return db.getTodos(userId);
  },
});

server.defineProcedure("addTodo", {
  resources: ({ ctx, outputs }) => [`user/${ctx.userId}/todos`, `todo/${outputs.id}`],
  procedure: async ({ inputs, derived }) => {
    const userId = derived.forceAuth();
    return db.createTodo(userId, inputs.title);
  },
});

server.assertAllDefined();

// 3. CLIENT SETUP (frontend - e.g., lib/client.ts)
import { CovenantReactClient } from "@covenant-rpc/react";
import { httpClientToServer } from "@covenant-rpc/client/interfaces/http";
import { emptyClientToSidekick } from "@covenant-rpc/client/interfaces/empty";

export const client = new CovenantReactClient(covenant, {
  serverConnection: httpClientToServer("/api/covenant"),
  sidekickConnection: emptyClientToSidekick(),
});
```

## Core Concepts

### Covenant Declaration

Covenants define the contract between frontend and backend using only validation schemas:

```typescript
import { declareCovenant, query, mutation, channel } from "@covenant-rpc/core";
import { z } from "zod";

const covenant = declareCovenant({
  procedures: {
    // Queries: read-only operations
    getUser: query({
      input: z.object({ id: z.string() }),
      output: userSchema,
    }),

    // Mutations: state-changing operations
    updateUser: mutation({
      input: z.object({ id: z.string(), name: z.string() }),
      output: userSchema,
    }),
  },

  channels: {
    // Real-time bidirectional communication
    notifications: channel({
      clientMessage: z.object({ ack: z.string() }),
      serverMessage: z.object({ type: z.string(), data: z.unknown() }),
      connectionRequest: z.object({ token: z.string() }),
      connectionContext: z.object({ userId: z.string() }),
      params: ["userId"], // Dynamic URL params
    }),
  },
});
```

**Rules for covenant files:**
- Import ONLY validation schemas (Zod, Drizzle table schemas, etc.)
- NEVER import backend implementation code
- Keep in a shared location accessible to both frontend and backend

### Server Implementation

```typescript
import { CovenantServer } from "@covenant-rpc/server";

const server = new CovenantServer(covenant, {
  // Per-request context (typically auth data)
  contextGenerator: async (i) => {
    const token = i.request.headers.get("Authorization");
    return { userId: await verifyToken(token), token };
  },

  // Shared utilities for all procedures
  derivation: async (i) => ({
    forceAuthenticated: () => {
      if (!i.ctx.userId) i.error("Not authenticated", 401);
      return i.ctx.userId;
    },
    db: getDatabase(),
  }),

  sidekickConnection: emptyServerToSidekick(),
  logLevel: "info", // "silent" | "error" | "warn" | "info" | "debug"
});
```

### Defining Procedures

```typescript
server.defineProcedure("procedureName", {
  // Resources this procedure touches (for cache invalidation)
  resources: ({ inputs, ctx, outputs }) => [
    "todos",
    `user/${ctx.userId}/todos`,
    `todo/${outputs.id}`,
  ],

  // Main procedure logic
  procedure: async ({ inputs, ctx, derived, logger, error, setHeader, request }) => {
    // Access validated input
    const { id } = inputs;

    // Use derivation utilities
    const userId = derived.forceAuthenticated();

    // Logging
    logger.info("Processing request");

    // Set response headers
    setHeader("X-Custom", "value");

    // Throw typed errors
    const item = await derived.db.find(id);
    if (!item) error("Not found", 404);

    return item;
  },
});

// Ensure all procedures are implemented
server.assertAllDefined();
```

### Defining Channels

```typescript
server.defineChannel("chat", {
  // Called when client connects
  onConnect: async ({ inputs, params, reject }) => {
    const room = await getRoom(params.roomId);
    if (!room) reject("Room not found", "client");

    // Return connection context (stored for message handlers)
    return { userId: inputs.username, room };
  },

  // Called when client sends message
  onMessage: async ({ inputs, params, context, error }) => {
    if (isSpam(inputs.text)) {
      error("Message rejected", "client");
    }
    await broadcastToRoom(params.roomId, inputs.text, context.userId);
  },
});
```

## Client Usage

### Basic Client

```typescript
import { CovenantClient } from "@covenant-rpc/client";
import { httpClientToServer } from "@covenant-rpc/client/interfaces/http";
import { emptyClientToSidekick } from "@covenant-rpc/client/interfaces/empty";

const client = new CovenantClient(covenant, {
  serverConnection: httpClientToServer("https://api.example.com/covenant", {
    "Authorization": `Bearer ${token}`,
  }),
  sidekickConnection: emptyClientToSidekick(),
});

// Queries
const result = await client.query("getTodos", null);
if (result.success) {
  console.log(result.data);      // Typed output
  console.log(result.resources); // Resource identifiers
} else {
  console.log(result.error.code, result.error.message);
}

// Mutations
const mutResult = await client.mutate("addTodo", { title: "Buy milk" });

// Listening (auto-refetch on resource changes)
const unsubscribe = client.listen("getTodos", null, (result) => {
  if (result.success) updateUI(result.data);
}, true); // remote: true for cross-client updates
```

### React Hooks

```typescript
import { CovenantReactClient } from "@covenant-rpc/react";

const client = new CovenantReactClient(covenant, { /* connections */ });

// useQuery - fetches on mount, refetches on input change
function TodoList() {
  const { loading, data, error } = client.useQuery("getTodos", null);

  if (loading) return <Loading />;
  if (error) return <Error message={error.message} />;
  return <List items={data} />;
}

// useMutation - returns [mutate, state]
function AddTodo() {
  const [addTodo, { loading, error }] = client.useMutation("addTodo", {
    optimisticData: (input) => ({ id: -1, title: input.title }),
    onSuccess: (data) => console.log("Added:", data),
    onError: (err) => console.log("Failed:", err),
  });

  return (
    <button onClick={() => addTodo({ title: "New" })} disabled={loading}>
      Add
    </button>
  );
}

// useListenedQuery - auto-refetches when resources invalidate
function LiveTodos() {
  const { data } = client.useListenedQuery("getTodos", null, true);
  return <List items={data} />;
}

// useCachedQuery - shared cache across component instances
function CachedTodos() {
  const { data } = client.useCachedQuery("getTodos", null, true);
  return <List items={data} />;
}

// Manual cache control
client.invalidateCache("getTodos", null);
client.clearCache();
```

### Channel Usage

```typescript
// 1. Connect to channel
const connectResult = await client.connect("chat", { roomId: "room1" }, {
  username: "Alice",
});
if (!connectResult.success) throw new Error(connectResult.error.message);
const token = connectResult.token;

// 2. Subscribe to server messages
const unsub = await client.subscribe("chat", { roomId: "room1" }, token, (msg) => {
  console.log("Received:", msg);
});

// 3. Send messages
await client.send("chat", { roomId: "room1" }, token, { text: "Hello!" });

// 4. Cleanup
unsub();
```

## Connections Reference

### Server Connections (procedure execution)

```typescript
// HTTP (production)
import { httpClientToServer } from "@covenant-rpc/client/interfaces/http";
httpClientToServer(url, headers);

// Direct (testing - bypasses HTTP)
import { directClientToServer } from "@covenant-rpc/server/interfaces/direct";
directClientToServer(server, headers);

// Empty (always fails - for testing without server)
import { emptyClientToServer } from "@covenant-rpc/client/interfaces/empty";
emptyClientToServer();
```

### Sidekick Connections (real-time & invalidation)

```typescript
// Client to Sidekick (WebSocket)
import { httpClientToSidekick } from "@covenant-rpc/client/interfaces/http";
httpClientToSidekick(sidekickUrl);

// Server to Sidekick (HTTP)
import { httpServerToSidekick } from "@covenant-rpc/server/interfaces/http";
httpServerToSidekick(sidekickUrl, secretKey);

// Empty (no real-time features)
import { emptyClientToSidekick, emptyServerToSidekick } from "@covenant-rpc/server/interfaces/empty";
```

## Testing Patterns

### Procedure Testing

```typescript
import { test, expect } from "bun:test";
import { declareCovenant, query } from "@covenant-rpc/core";
import { CovenantServer } from "@covenant-rpc/server";
import { CovenantClient } from "@covenant-rpc/client";
import { directClientToServer } from "@covenant-rpc/server/interfaces/direct";
import { emptyClientToSidekick, emptyServerToSidekick } from "@covenant-rpc/server/interfaces/empty";

test("procedure returns correct data", async () => {
  const covenant = declareCovenant({
    procedures: {
      greet: query({
        input: z.object({ name: z.string() }),
        output: z.object({ message: z.string() }),
      }),
    },
    channels: {},
  });

  const server = new CovenantServer(covenant, {
    contextGenerator: () => undefined,
    derivation: () => {},
    sidekickConnection: emptyServerToSidekick(),
  });

  server.defineProcedure("greet", {
    resources: () => [],
    procedure: ({ inputs }) => ({ message: `Hello, ${inputs.name}` }),
  });

  const client = new CovenantClient(covenant, {
    serverConnection: directClientToServer(server, {}),
    sidekickConnection: emptyClientToSidekick(),
  });

  const result = await client.query("greet", { name: "World" });

  expect(result.success).toBe(true);
  expect(result.data).toEqual({ message: "Hello, World" });
});
```

### Channel Testing with InternalSidekick

```typescript
import { InternalSidekick } from "@covenant-rpc/sidekick/internal";

test("channel communication", async () => {
  const sidekick = new InternalSidekick();
  const messages: string[] = [];

  const server = new CovenantServer(covenant, {
    contextGenerator: () => undefined,
    derivation: () => {},
    sidekickConnection: sidekick.getConnectionFromServer(),
  });

  sidekick.setServerCallback((channelName, params, data, context) =>
    server.processChannelMessage(channelName, params, data, context)
  );

  server.defineChannel("chat", {
    onConnect: ({ inputs }) => ({ userId: inputs.username }),
    onMessage: ({ inputs }) => { messages.push(inputs.text); },
  });

  const client = new CovenantClient(covenant, {
    serverConnection: directClientToServer(server, {}),
    sidekickConnection: sidekick.getConnectionFromClient(),
  });

  const conn = await client.connect("chat", { roomId: "room1" }, { username: "Alice" });
  await client.send("chat", { roomId: "room1" }, conn.token, { text: "Hello!" });

  await new Promise(r => setTimeout(r, 50));
  expect(messages).toEqual(["Hello!"]);
});
```

## Resource Invalidation Pattern

Resources enable automatic cache invalidation when data changes:

```typescript
// Server: define resources for each procedure
server.defineProcedure("addTodo", {
  resources: ({ ctx, outputs }) => [
    "todos",                    // Invalidates all todo lists
    `user/${ctx.userId}/todos`, // Invalidates user-specific lists
    `todo/${outputs.id}`,       // Specific todo resource
  ],
  procedure: async ({ inputs, ctx }) => db.createTodo(ctx.userId, inputs.title),
});

// Client: listen for resource changes
const unsub = client.listen("getTodos", { userId: 123 }, (result) => {
  if (result.success) setTodos(result.data);
}, true); // remote=true for cross-client updates via Sidekick

// When mutation runs, listeners for matching resources auto-refetch
await client.mutate("addTodo", { title: "Buy milk" });
// ^ Triggers refetch of getTodos because resources overlap
```

## Context and Derivation Pattern

```typescript
const server = new CovenantServer(covenant, {
  // Context: per-request data (auth, request metadata)
  contextGenerator: async (i) => {
    const session = await getSession(i.request);
    return { userId: session?.userId, role: session?.role };
  },

  // Derivation: shared utilities that can access context
  derivation: async (i) => ({
    forceAuth: () => {
      if (!i.ctx.userId) i.error("Unauthorized", 401);
      return i.ctx.userId;
    },
    forceAdmin: () => {
      const userId = i.ctx.userId;
      if (!userId || i.ctx.role !== "admin") i.error("Forbidden", 403);
      return userId;
    },
    db: initDb(),
  }),

  sidekickConnection: emptyServerToSidekick(),
});

// Use in procedures
server.defineProcedure("adminAction", {
  resources: () => [],
  procedure: async ({ derived }) => {
    const adminId = derived.forceAdmin(); // Throws if not admin
    return derived.db.doAdminThing(adminId);
  },
});
```

## Sidekick Service (Production)

For real-time features in production, run Sidekick as a standalone service:

```typescript
// sidekick-server.ts
import { getSidekickApi } from "@covenant-rpc/sidekick/web";

const app = getSidekickApi("your-secret-key");
app.listen({ port: 3001 });
```

Then connect server and clients:

```typescript
// Server
import { httpServerToSidekick } from "@covenant-rpc/server/interfaces/http";
sidekickConnection: httpServerToSidekick("http://localhost:3001", "your-secret-key");

// Client
import { httpClientToSidekick } from "@covenant-rpc/client/interfaces/http";
sidekickConnection: httpClientToSidekick("ws://localhost:3001");
```

## Error Handling

```typescript
// In procedures, use the error function
server.defineProcedure("getTodo", {
  procedure: ({ inputs, error }) => {
    const todo = findTodo(inputs.id);
    if (!todo) error("Todo not found", 404); // Throws, never returns
    return todo;
  },
  resources: () => [],
});

// Client handles errors via result type
const result = await client.query("getTodo", { id: 999 });
if (!result.success) {
  console.log(result.error.code);    // 404
  console.log(result.error.message); // "Todo not found"
}
```

## Validation

Covenant supports any Standard Schema compliant library:
- Zod (most common)
- ArcType
- Valibot
- Others implementing Standard Schema V1

**Important:** Do NOT use the internal `validation.ts` from @covenant-rpc/core in application code - it's for framework internals only.

## Key Files Reference

| Import | Purpose |
|--------|---------|
| `@covenant-rpc/core` | `declareCovenant`, `query`, `mutation`, `channel` |
| `@covenant-rpc/server` | `CovenantServer` |
| `@covenant-rpc/client` | `CovenantClient` |
| `@covenant-rpc/react` | `CovenantReactClient` with React hooks |
| `@covenant-rpc/server/interfaces/direct` | `directClientToServer` (testing) |
| `@covenant-rpc/server/interfaces/empty` | `emptyServerToSidekick`, `emptyClientToSidekick` |
| `@covenant-rpc/client/interfaces/http` | `httpClientToServer`, `httpClientToSidekick` |
| `@covenant-rpc/server/interfaces/http` | `httpServerToSidekick` |
| `@covenant-rpc/sidekick/internal` | `InternalSidekick` (testing) |
| `@covenant-rpc/sidekick/web` | `getSidekickApi` (production) |
