---
title: Protocol reference
description: The shared types, schemas, and constants exported by fleet-protocol.
sidebar:
  order: 5
---

`fleet-protocol` is the shared contract between the ship, the bridge, the web
client, and the CLI. It is pure types, zod schemas, and two constants — no
runtime dependencies beyond zod.

Everything is exported from the package root:

```ts
import { AGENT_STATES, decodeFleetEvent, DEFAULT_PORT } from "fleet-protocol";
import type { FleetEvent, WorkspaceStatus } from "fleet-protocol";
```

Some values are zod schemas and some are plain TypeScript types. The rule is
deliberate: anything a third party decodes from a raw string at runtime (the
event union, the workspace DTOs it embeds, the persisted records) is a schema;
anything that only ever travels over the typed Eden HTTP surface
(`SystemResources`, `UpdateAgentStatusRequest`, `SwitchBranchRequest`) is a
plain interface.

## Complete export list

| Export | Kind |
| --- | --- |
| `FleetIdentifierSchema`, `parseFleetIdentifier`, `FleetIdentifier` | schema, function, type |
| `DEFAULT_PORT`, `ATLAS_FILENAME` | constants |
| `FleetShipConfigSchema`, `FleetShipConfig` | schema, type |
| `AtlasSchema`, `Atlas` | schema, type |
| `AGENT_STATES`, `AgentState` | constant, type |
| `AgentStatusSchema`, `AgentStatus` | schema, type |
| `WorkspaceSummarySchema`, `WorkspaceSummary` | schema, type |
| `WorkspaceDiffSchema`, `WorkspaceDiff` | schema, type |
| `WorkspaceStatusSchema`, `WorkspaceStatus` | schema, type |
| `CreateWorkspaceRequestSchema`, `CreateWorkspaceRequest` | schema, type |
| `UpdateAgentStatusRequest`, `SwitchBranchRequest` | types only |
| `SystemResources` | type only |
| `RepoSchema`, `Repo`, `CreateRepoInputSchema`, `CreateRepoInput` | schemas, types |
| `ShipSchema`, `Ship` | schema, type |
| `SyncEventSchema`, `SyncEvent` | schema, type |
| `WorkspaceCreatedEventSchema`, `WorkspaceBranchChangedEventSchema`, `WorkspaceActivatedEventSchema`, `WorkspaceDeactivatedEventSchema`, `WorkspaceAgentStatusChangedEventSchema`, `WorkspaceRemovedEventSchema` | schemas |
| `FleetEventSchema`, `FleetEvent`, `decodeFleetEvent` | schema, type, function |

## Identifiers

Repo names, workspace names, and ship names are all *fleet identifiers*.
`FleetIdentifierSchema` is a `z.string()` with five refinements:

| Rule | Message |
| --- | --- |
| At least 1 character | zod's `min(1)` |
| At most 128 UTF-8 **bytes** (not characters) | `must be at most 128 UTF-8 bytes` |
| Not `.` and not `..` | `must not be . or ..` |
| Contains neither `/` nor `\` | `must not contain path separators` |
| No Unicode control characters (`\p{Cc}`) | `must not contain Unicode control characters` |
| No lone surrogates (`\p{Cs}`) | `must be well-formed Unicode` |

Note what is *not* restricted: spaces, dots elsewhere in the string, uppercase,
and non-ASCII letters are all allowed.

```ts
type FleetIdentifier = string;
function parseFleetIdentifier(value: unknown): FleetIdentifier; // throws ZodError
```

A workspace's fleet-wide identity is the `(repoName, name)` pair, rendered as
`<repoName>/<name>`. Names are unique only within a repo on a ship; the bridge
enforces that the pair is unique across the whole fleet.

## Workspace states

A workspace is in exactly one of two states, determined by whether a tmux
session exists for it:

| State | Meaning |
| --- | --- |
| `inactive` | Only the directory exists. |
| `active` | A tmux session is up. |

`WorkspaceSummary` carries this as the boolean `active`; `WorkspaceStatus`
carries it as the discriminant `state`.

### `WorkspaceSummary`

The list row, also embedded in every event.

```ts
{
  repoName: FleetIdentifier;
  name: FleetIdentifier;
  branch: string;
  active: boolean;
  agent: AgentStatus | null;   // schema default: null
}
```

`agent` has a schema default of `null`, so parsing an object that omits it
succeeds and yields `agent: null`.

### `WorkspaceStatus`

A discriminated union on `state`.

```ts
type WorkspaceStatus =
  | {
      state: "inactive";
      repoName: FleetIdentifier;
      name: FleetIdentifier;
      branch: string;
    }
  | {
      state: "active";
      repoName: FleetIdentifier;
      name: FleetIdentifier;
      branch: string;
      diff: WorkspaceDiff;
      agent: AgentStatus | null;
      issue: null;
      mergeRequest: null;
      ship: FleetIdentifier;
    };
```

`issue` and `mergeRequest` are typed `z.null()` — they are reserved slots and
are always `null` today.

The bridge returns this same union with a `ship` field added to **both**
variants (`BridgeWorkspaceStatus`); see
[bridge API](/reference/bridge-api/).

### `WorkspaceDiff`

```ts
{
  added: number;    // lines added across the working tree
  removed: number;  // lines removed across the working tree
  commits: number;  // commits ahead of upstream (0 if no upstream)
}
```

## Agent state and status

```ts
const AGENT_STATES = ["idle", "planning", "building", "verifying", "awaiting"] as const;
type AgentState = "idle" | "planning" | "building" | "verifying" | "awaiting";
```

| State | Meaning |
| --- | --- |
| `idle` | No task in progress. The state `agent/init` seeds. |
| `planning` | Working out an approach. |
| `building` | Making changes. |
| `verifying` | Checking its own work. |
| `awaiting` | Blocked on a human. |

```ts
interface AgentStatus {
  state: AgentState;
  description: string;   // free text, no schema-enforced length
  model: string;
  provider: string;
  harness: string;
}
```

`model`, `provider`, and `harness` are fixed when the session is created by
`agent/init` and preserved across status updates. Agent status is in-memory
runtime state on the ship: it is never persisted, and it is cleared when the
workspace is deactivated or removed.

## Request bodies

```ts
// POST /workspaces (ship)
const CreateWorkspaceRequestSchema = z.object({
  url: z.string(),                 // git clone URL
  repoName: FleetIdentifierSchema,
  name: FleetIdentifierSchema,
  branch: z.string(),
});

// POST /workspaces/:repo/:name/branch
interface SwitchBranchRequest { readonly branch: string }

// POST /workspaces/:repo/:name/agent/status
interface UpdateAgentStatusRequest {
  readonly state: AgentState;
  readonly description: string;
}
```

The bridge's create body is a different shape (`{ship, repoName, name, branch}`)
and lives in `fleet-bridge`, not here.

## Events

The `/events` WebSocket stream. Every event extends a common base:

```ts
{
  ship: FleetIdentifier;   // name of the emitting ship
  at: string;              // ISO 8601 timestamp
}
```

| Schema | `type` | Payload |
| --- | --- | --- |
| `SyncEventSchema` | `sync` | `workspaces: WorkspaceSummary[]` |
| `WorkspaceCreatedEventSchema` | `workspace.created` | `workspace: WorkspaceSummary` |
| `WorkspaceBranchChangedEventSchema` | `workspace.branch_changed` | `workspace: WorkspaceSummary` |
| `WorkspaceActivatedEventSchema` | `workspace.activated` | `workspace: WorkspaceSummary` |
| `WorkspaceDeactivatedEventSchema` | `workspace.deactivated` | `workspace: WorkspaceSummary` |
| `WorkspaceAgentStatusChangedEventSchema` | `workspace.agent_status_changed` | `workspace: WorkspaceSummary` |
| `WorkspaceRemovedEventSchema` | `workspace.removed` | `workspace: WorkspaceSummary` |

`FleetEventSchema` is the discriminated union of all seven on `type`.

```ts
function decodeFleetEvent(raw: string | unknown): FleetEvent;
```

Decodes a raw frame — a JSON string, or an already-parsed object — into a
validated `FleetEvent`, throwing a `ZodError` if it does not match. `sync` is
sent once when a client connects; the rest stream as changes happen.

:::note
`workspace.created` and `workspace.removed` are the only two events whose
workspace does not necessarily reflect live disk state: `created` always reports
`active: false` and `agent: null`, and `removed` reports the branch captured
immediately before deletion (`""` if it could not be read).
:::

The bridge publishes a **different** union (`BridgeWorkspaceEvent`, defined in
`fleet-bridge`): no top-level `ship`, and each workspace annotated with the ship
that hosts it. See [events](/concepts/events/).

## Ships and repos

These are the records the bridge persists (`ships.json`, `repos.json`) and
serves.

```ts
const ShipSchema = z.object({
  name: FleetIdentifierSchema,
  url: z.string(),
});

const RepoSchema = z.object({
  name: FleetIdentifierSchema,   // also the ship-side directory under fleetDirectory
  url: z.string(),               // git clone URL
  provider: z.string(),          // e.g. "github", "gitlab", "custom"
});

// POST /repos body: provider is optional and defaults to "custom" in the bridge
const CreateRepoInputSchema = RepoSchema.omit({ provider: true })
  .extend({ provider: z.string().optional() });
```

`Ship` is the persisted record. The richer `ShipInfo` returned by
`GET /ships` — the same two fields plus a `status` of `"online" | "offline"` —
is a bridge-local type, not part of this package.

## System resources

A plain interface (no schema), reported by a ship's `GET /system-resources`.

```ts
interface SystemResources {
  readonly uptimeSeconds: number;               // os.uptime()
  readonly os: {
    readonly type: string;                      // os.type(), e.g. "Linux"
    readonly platform: string;                  // os.platform(), e.g. "linux"
    readonly release: string;                   // os.release()
    readonly version: string;                   // os.version()
    readonly arch: string;                      // os.arch(), e.g. "x64"
    readonly machine: string;                   // os.machine(), e.g. "x86_64"
    readonly hostname: string;                  // os.hostname()
  };
  readonly cpu: {
    readonly model: string;                     // os.cpus()[0].model, or "unknown"
    readonly cores: number;                     // os.cpus().length
    readonly usage: number;                     // 0..1 busy fraction, briefly sampled
    readonly loadAverage: readonly [number, number, number];  // 1/5/15-minute
  };
  readonly memory: {
    readonly total: number;                     // bytes, os.totalmem()
    readonly free: number;                      // bytes, os.freemem()
    readonly used: number;                      // total - free
    readonly usage: number;                     // used / total, 0..1
  };
}
```

`loadAverage` is all zeros on platforms that do not support it.

## Ship config and discovery

```ts
const FleetShipConfigSchema = z.object({
  fleetDirectory: z.string().min(1),   // holds <fleetDirectory>/<repo>/<name>
  port: z.number().int(),
  name: FleetIdentifierSchema,         // surfaced as `ship` on active status
});
```

The ship assembles this object from its CLI flags and validates it against the
schema, then resolves `fleetDirectory` to an absolute, symlink-resolved path.

```ts
const AtlasSchema = z.object({ port: z.number().int() });
```

`atlas.json` is the discovery file the ship writes to the root of its
`fleetDirectory` on startup. Because workspaces live at
`<fleetDirectory>/<repo>/<name>`, an agent inside a workspace can walk up two
levels to find it and learn the local port to reach its ship — which is exactly
what `fleet agent` does.

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `DEFAULT_PORT` | `4700` | Port the CLI falls back to when no `--url` is given. Ships may listen on any port; this is only the client-side default and the `fleet ship --port` default. |
| `ATLAS_FILENAME` | `"atlas.json"` | Name of the ship's discovery file. |

Two related constants live outside this package:

| Constant | Value | Package |
| --- | --- | --- |
| `DEFAULT_BRIDGE_PORT` | `4800` | `fleet-bridge` |
| `WORKSPACE_TMUX_NAMESPACE` | `"fleet-ship"` | `fleet-ship` — the tmux server socket name (`tmux -L fleet-ship`) |

Workspace tmux sessions are named `ws-<sha256 hex>`, hashed from a
version-tagged, length-prefixed encoding of the `(repoName, name)` pair so that
two different pairs can never collide on one session name.
