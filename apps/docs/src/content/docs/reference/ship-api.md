---
title: Ship API reference
description: Every HTTP route and WebSocket endpoint served by a fleet-ship host.
sidebar:
  order: 2
---

A ship serves an [Elysia](https://elysiajs.com) app on the port given by
`fleet ship --port` (default `4700`). There is no authentication and no route
prefix: paths are absolute from the origin. The app is composed of three
plugins — workspaces (including the terminal WebSocket), events, and system
resources.

## Routes at a glance

| Method | Path | Success | Body |
| --- | --- | --- | --- |
| GET | `/workspaces` | 200 | `WorkspaceSummary[]` |
| GET | `/workspaces/:repo/:name` | 200 | `WorkspaceStatus` |
| GET | `/workspaces/:repo/:name/diff` | 200 | raw diff text |
| POST | `/workspaces` | 201 | `WorkspaceSummary` |
| POST | `/workspaces/:repo/:name/branch` | 200 | `{ ok: true }` |
| POST | `/workspaces/:repo/:name/activate` | 200 | `{ ok: true }` |
| POST | `/workspaces/:repo/:name/deactivate` | 200 | `{ ok: true }` |
| DELETE | `/workspaces/:repo/:name` | 200 | `{ ok: true }` |
| POST | `/workspaces/:repo/:name/agent/init` | 200 | `AgentStatus` |
| GET | `/workspaces/:repo/:name/agent/status` | 200 | `AgentStatus` or `null` |
| POST | `/workspaces/:repo/:name/agent/status` | 200 | `AgentStatus` |
| GET | `/system-resources` | 200 | `SystemResources` |
| WS | `/workspaces/:repo/:name/terminal` | — | webterm protocol |
| WS | `/events` | — | `FleetEvent` stream |

Path parameters are the same everywhere:

| Parameter | Meaning |
| --- | --- |
| `:repo` | Repo name — the directory the workspace lives under. |
| `:name` | Workspace name, unique within its repo. |

Both must be valid [fleet identifiers](/reference/protocol/); anything else is a
`400` with `{"error": "invalid repo identifier"}` or
`{"error": "invalid workspace identifier"}`.

## Error shape and status codes

Every handler catches its errors and returns a JSON object with a single
`error` string:

```ts
{ error: string }
```

The status comes from the thrown `WorkspaceError`; anything else is a `500`
carrying the error's message.

| Status | Raised when |
| --- | --- |
| `400` | Invalid repo/workspace identifier; a path that escapes the fleet directory; `invalid workspace create request`; `workspace not active: <repo>/<name>`; `workspace already active: <repo>/<name>`; `agent not initialized: <repo>/<name>`. |
| `404` | `workspace not found: <repo>/<name>` — the directory does not exist or is not a git working tree. |
| `409` | The clone destination already exists (`POST /workspaces`). |
| `422` | Elysia schema validation — a missing or wrongly typed request body/query field. Note this is Elysia's own error shape, not `{error}`. |
| `500` | Any error that is not a `WorkspaceError`. |

## `GET /workspaces`

Lists every workspace directory under the ship's fleet directory that is a git
working tree.

| Query | Type | Default | Meaning |
| --- | --- | --- | --- |
| `active` | string | absent | `"true"` → only active, `"false"` → only inactive. Any other value (including `garbage`) is treated as absent, i.e. no filter. |

Response: an array of `WorkspaceSummary`.

```ts
{
  repoName: string;
  name: string;
  branch: string;
  active: boolean;
  agent: AgentStatus | null;
}[]
```

Disk entries that are invalid, or that disappear between discovery and use, are
silently omitted rather than failing the request.

## `GET /workspaces/:repo/:name`

Detailed status for one workspace. The response is a discriminated union on
`state`.

```ts
// state: "inactive"
{ state: "inactive"; repoName: string; name: string; branch: string }

// state: "active"
{
  state: "active";
  repoName: string;
  name: string;
  branch: string;
  diff: { added: number; removed: number; commits: number };
  agent: AgentStatus | null;
  issue: null;
  mergeRequest: null;
  ship: string;   // this ship's configured name
}
```

`diff.added` / `diff.removed` are line counts from `git diff --numstat HEAD`
(binary files are skipped) and `diff.commits` is the number of commits ahead of
upstream.

Errors: `400` invalid identifier, `404` workspace not found.

## `GET /workspaces/:repo/:name/diff`

Raw `git diff` output as text, not JSON. Works whether or not the workspace is
active, since it reads the on-disk tree.

| Query | Type | Default | Meaning |
| --- | --- | --- | --- |
| `staged` | boolean | absent | Diff the index against `HEAD` (`--staged`). |
| `stat` | boolean | absent | Emit a diffstat summary (`--stat`) instead of the full patch. |
| `nameOnly` | boolean | absent | List only changed paths (`--name-only`). |
| `range` | string | absent | Commit or range to diff, e.g. `HEAD~1` or `main..feature`. |
| `paths` | string[] | absent | Restrict the diff to these paths. Repeat the key: `?paths=a.ts&paths=b.ts`. |
| `includeUntracked` | boolean | absent | Append synthesized add-file diffs for untracked files. |

Omitted query keys are omitted from the options object entirely, not defaulted
to `false`.

Errors are still JSON: a `404` returns `{"error": "workspace not found: …"}` in
the response text.

## `POST /workspaces`

Creates a workspace by cloning `url` into `<fleetDirectory>/<repoName>/<name>`
on `branch`. Returns `201`.

```ts
// request body — all four fields required
{ url: string; repoName: string; name: string; branch: string }

// 201 response
{ repoName: string; name: string; branch: string; active: false; agent: null }
```

Errors: `422` if a body field is missing or mistyped, `400` for an invalid
identifier or `invalid workspace create request`, `409` if the destination
directory already exists.

A new workspace always starts inactive; the `workspace.created` event is emitted
on `/events`.

## `POST /workspaces/:repo/:name/branch`

Switches the workspace to `branch`, creating it if it does not exist
(`git switch --create`).

```ts
{ branch: string }   // request
{ ok: true }         // 200 response
```

Emits `workspace.branch_changed`.

## `POST /workspaces/:repo/:name/activate`

Starts the workspace's tmux session. No request body. Responds `{ ok: true }`.

Errors: `400` `workspace already active: <repo>/<name>`, `404` workspace not
found. Emits `workspace.activated`.

## `POST /workspaces/:repo/:name/deactivate`

Kills the workspace's tmux session and clears its in-memory agent status. No
request body. Responds `{ ok: true }`.

Errors: `400` `workspace not active: <repo>/<name>`, `404` workspace not found.
Emits `workspace.deactivated`.

## `DELETE /workspaces/:repo/:name`

Kills the session if one is up, deletes the workspace directory recursively, and
clears its agent status. Responds `{ ok: true }`.

Errors: `404` workspace not found. Emits `workspace.removed`, whose
`workspace.branch` is the branch captured immediately before deletion (`""` if
it could not be read).

## `POST /workspaces/:repo/:name/agent/init`

Attaches (or resets) an agent session on an **active** workspace, seeding its
status to `idle` with the description
`Created session at <ISO timestamp>`.

```ts
// request body — all three fields required
{ model: string; provider: string; harness: string }

// 200 response
{
  state: "idle";
  description: string;
  model: string;
  provider: string;
  harness: string;
}
```

Errors: `422` missing body fields, `400` `workspace not active: <repo>/<name>`,
`404` workspace not found. Emits `workspace.agent_status_changed`.

## `GET /workspaces/:repo/:name/agent/status`

Returns the live `AgentStatus`, or `null` when no agent is attached — in which
case the HTTP response body is empty.

:::note
This route validates the identifiers but does not require the workspace to
exist; an unknown workspace simply reports no agent rather than `404`.
:::

## `POST /workspaces/:repo/:name/agent/status`

Updates the live status, preserving the session's `model` / `provider` /
`harness`.

```ts
// request body
{ state: "idle" | "planning" | "building" | "verifying" | "awaiting"; description: string }

// 200 response: the full AgentStatus after the update
```

Errors: `422` if `state` is outside the union or `description` is missing, `400`
`agent not initialized: <repo>/<name>` when `agent/init` has not run, `404`
workspace not found. Emits `workspace.agent_status_changed`.

Agent status is in-memory runtime state tied to the tmux session. It is never
persisted and is dropped on deactivate, remove, or ship restart.

## `GET /system-resources`

A point-in-time snapshot of the host, gathered from `node:os`. CPU usage is
sampled over a 100 ms window, so this route takes at least that long to respond.

```ts
{
  uptimeSeconds: number;
  os: {
    type: string; platform: string; release: string; version: string;
    arch: string; machine: string; hostname: string;
  };
  cpu: {
    model: string;                       // first core's model, or "unknown"
    cores: number;
    usage: number;                       // 0..1 busy fraction
    loadAverage: [number, number, number]; // 1/5/15-minute
  };
  memory: { total: number; free: number; used: number; usage: number };
}
```

This route has no error mapping — it always returns `200` on a healthy host.

## `WS /events`

A read-only broadcast of workspace and agent state changes. Anything the client
sends is ignored.

On connect the ship sends a `sync` snapshot, then one event per change. Every
frame is JSON text and matches the `FleetEvent` union documented in
[protocol](/reference/protocol/):

```ts
{ type: "sync"; ship: string; at: string; workspaces: WorkspaceSummary[] }
{ type: "workspace.created" | "workspace.branch_changed"
      | "workspace.activated" | "workspace.deactivated"
      | "workspace.agent_status_changed" | "workspace.removed";
  ship: string; at: string; workspace: WorkspaceSummary }
```

`ship` is the ship's configured name and `at` is an ISO 8601 timestamp.

Changes emitted while the initial snapshot is still being built are buffered and
replayed immediately after it, so no event is lost on connect.

| Close code | Reason | Cause |
| --- | --- | --- |
| `1011` | `Failed to build workspace snapshot` | The snapshot could not be produced on connect. |
| `1009` | `Terminal buffer limit exceeded` | More than 256 KiB of events queued while the snapshot was pending. |

## `WS /workspaces/:repo/:name/terminal`

Attaches a terminal to the workspace's tmux session by running
`tmux -L fleet-ship attach -t ws-<sha256>`. The wire format is the webterm
protocol: the server parses the shell's VT bytes and streams full grid
snapshots; the client sends keystrokes.

Client → server messages (JSON text only):

```ts
{ type: "init"; cols: number; rows: number }    // must be first, exactly once
{ type: "input"; data: string }
{ type: "resize"; cols: number; rows: number }
```

`cols` is 1–1024, `rows` is 1–512, and `input.data` is at most 256 KiB of UTF-8.
The socket's max payload is 1,572,992 bytes.

Server → client messages: `grid` snapshots and a final
`{ type: "exit", code: number }`.

Connection rules:

| Behavior | Detail |
| --- | --- |
| One terminal per workspace | A second connection for the same session immediately receives `{"type":"exit","code":1}` and is closed. The guard is released when the first connection closes. |
| `init` deadline | The first message must be `init` within 5000 ms, else close `1008` / `terminal init timeout`. |
| `init` exactly once | A non-`init` before `init`, or a second `init`, closes `1008` / `Invalid terminal message`. |
| Undecodable frame | Close `1008` / `Invalid terminal message`. |
| Binary frame | Close `1003` / `Binary terminal messages are not supported`. |
| Shell exit | The server sends `exit`, then closes and releases the guard. |

:::caution
The route does not verify that the workspace exists or is active before
attaching. Attaching to a workspace with no tmux session ends with an `exit`
frame from the failed `tmux attach`.
:::
