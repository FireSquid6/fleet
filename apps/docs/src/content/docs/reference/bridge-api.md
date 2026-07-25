---
title: Bridge API reference
description: Every HTTP route and WebSocket endpoint served by fleet-bridge, and how it differs from a ship.
sidebar:
  order: 3
---

A bridge serves an Elysia app on the port given by `fleet bridge --port`
(default `4800`). Like a ship it has no authentication and no route prefix.

The workspace surface is a **superset of the [ship API](/reference/ship-api/)**:
the owning ship is abstracted away — routing is automatic — but kept visible,
since every workspace response carries a `ship` field. On top of that the bridge
adds ship management, a repo registry, and an aggregate system-resources view.

## Relationship to the ship API

| Ship route | On the bridge |
| --- | --- |
| `GET /workspaces` | Same path. Merged across ships, deduped, each row gains `ship`. |
| `GET /workspaces/:repo/:name` | Same path. Proxied live to the owning ship; response gains `ship` on **both** the `active` and `inactive` variants. |
| `GET /workspaces/:repo/:name/diff` | Same path and query. Proxied verbatim. |
| `POST /workspaces` | Same path, **different body**: `{ship, repoName, name, branch}` instead of `{url, repoName, name, branch}`. The clone URL comes from the bridge's repo registry. Response gains `ship`. |
| `POST /workspaces/:repo/:name/branch` | Same. |
| `POST /workspaces/:repo/:name/activate` | Same. |
| `POST /workspaces/:repo/:name/deactivate` | Same. |
| `DELETE /workspaces/:repo/:name` | Same. |
| `WS /workspaces/:repo/:name/terminal` | Same path; a bidirectional pipe to the owning ship's terminal. |
| `WS /events` | Same path, **different frames**: no top-level `ship`, and every workspace carries `ship`. |
| `GET /system-resources` | Same path, **different shape**: an array with one entry per ship. The single-host snapshot moves to `GET /ships/:ship/system-resources`. |
| `POST /workspaces/:repo/:name/agent/init` | **Not present.** |
| `GET`/`POST /workspaces/:repo/:name/agent/status` | **Not present.** Agent status still reaches the bridge through each ship's `/events` stream, as the `agent` field on every workspace. |

Bridge-only routes: `GET`/`POST /ships`, `DELETE /ships/:name`,
`GET /ships/:ship/system-resources`, `GET`/`POST /repos`,
`DELETE /repos/:name`.

## Routes at a glance

| Method | Path | Success | Body |
| --- | --- | --- | --- |
| GET | `/ships` | 200 | `ShipInfo[]` |
| POST | `/ships` | 201 | `ShipInfo` |
| DELETE | `/ships/:name` | 200 | `{ ok: true }` |
| GET | `/ships/:ship/system-resources` | 200 | `SystemResources` |
| GET | `/system-resources` | 200 | `ShipSystemResources[]` |
| GET | `/repos` | 200 | `Repo[]` |
| POST | `/repos` | 201 | `Repo` |
| DELETE | `/repos/:name` | 200 | `{ ok: true }` |
| GET | `/workspaces` | 200 | `BridgeWorkspaceSummary[]` |
| GET | `/workspaces/:repo/:name` | 200 | `BridgeWorkspaceStatus` |
| GET | `/workspaces/:repo/:name/diff` | 200 | raw diff text |
| POST | `/workspaces` | 201 | `BridgeWorkspaceSummary` |
| POST | `/workspaces/:repo/:name/branch` | 200 | `{ ok: true }` |
| POST | `/workspaces/:repo/:name/activate` | 200 | `{ ok: true }` |
| POST | `/workspaces/:repo/:name/deactivate` | 200 | `{ ok: true }` |
| DELETE | `/workspaces/:repo/:name` | 200 | `{ ok: true }` |
| WS | `/workspaces/:repo/:name/terminal` | — | webterm protocol, proxied |
| WS | `/events` | — | `BridgeWorkspaceEvent` stream |

## Error shape and status codes

Identical in shape to the ship's:

```ts
{ error: string }
```

The status comes from the thrown `BridgeError`; anything else is a `500`.

| Status | Raised when |
| --- | --- |
| `400` | Invalid repo/workspace/ship identifier; `unknown ship: <name>` (create, or per-ship resources); `unknown repo: <name>`; `invalid repo`. |
| `404` | `workspace not found: <repo>/<name>` — no ship in the ownership index holds it; `ship not found: <name>`; `repo not found: <name>`. |
| `409` | `ship already registered: <name>`; a registering ship holds workspaces already hosted elsewhere; `workspace already exists: <repo>/<name>`; a create already in progress or of indeterminate outcome for that key; a ship removed mid-request. |
| `422` | Elysia schema validation on the request body. |
| `502` | `ship at <url> did not respond: <message>` (`POST /ships`); a ship returned no data, an invalid summary/status, or a workspace identity that was not requested. |
| `503` | `ship "<name>" hosting <repo>/<name> is offline`; `ship "<name>" is offline` (create, per-ship resources); `ship "<name>" unreachable: <message>`. |
| ship's status | Any error the owning ship returned is passed through with the ship's own status and message. |

### Offline ships and unknown workspaces

These two cases are the ones worth memorizing:

- **Unknown workspace** → `404 {"error": "workspace not found: <repo>/<name>"}`.
  The bridge routes from an in-memory index built from every online ship's
  `/events` stream. A workspace it has never seen — or one whose only owner has
  been deregistered — is simply not in that index.
- **Offline ship** → `503`. Every routed operation (`GET`, `diff`, `branch`,
  `activate`, `deactivate`, `DELETE`, terminal target) requires the owning ship
  to be `online`; otherwise
  `ship "<name>" hosting <repo>/<name> is offline`. A ship that fails at the
  transport layer mid-call is flipped offline and the call becomes
  `ship "<name>" unreachable: <message>`.

`GET /system-resources` is the one exception: offline ships are reported inline
with `resources: null` rather than failing the aggregate.

`GET /workspaces` also degrades rather than failing: ships that are offline or
that error are skipped, and the response lists whatever the bridge last knew.

## Ship management

### `GET /ships`

No query parameters.

```ts
{ name: string; url: string; status: "online" | "offline" }[]
```

`status` is `online` exactly while the bridge holds an open `/events` socket to
that ship.

### `POST /ships`

```ts
{ url: string }   // request
```

The bridge opens a probe connection, waits up to 5000 ms for the ship's first
`sync` event, and learns the ship's name from it — the caller never supplies a
name. On success it adopts the connection, claims that ship's workspaces, and
persists the roster to `ships.json`. Returns `201` with the `ShipInfo`.

| Status | Cause |
| --- | --- |
| `422` | `url` missing. |
| `502` | `ship at <url> did not respond: <message>` — no `sync` within the timeout, or an invalid ship identity. |
| `409` | `ship already registered: <name>`, or `ship "<name>" has workspaces already hosted elsewhere: <keys>`. |

### `DELETE /ships/:name`

Closes the connection, releases every workspace it owned, drops any pending
create reservations for it, and re-persists the roster. Responds `{ ok: true }`.

| Status | Cause |
| --- | --- |
| `400` | Invalid ship identifier. |
| `404` | `ship not found: <name>`. |

A released workspace key is handed to another ship that also reports it, if any
(online ships preferred, then alphabetically by name); otherwise it leaves the
index and subsequent requests for it return `404`.

## System resources

### `GET /system-resources`

Fetches every ship's snapshot in parallel. Never fails because of one ship.

```ts
{
  ship: string;
  status: "online" | "offline";
  resources: SystemResources | null;
  error: string | null;
}[]
```

| Ship state | `resources` | `error` |
| --- | --- | --- |
| online, responded | the snapshot | `null` |
| online, request failed | `null` | the error message |
| offline | `null` | `null` |

### `GET /ships/:ship/system-resources`

Proxies the request live to one ship and returns its `SystemResources` object
unchanged (see [ship API](/reference/ship-api/)).

| Status | Cause |
| --- | --- |
| `400` | `unknown ship: <name>`. |
| `503` | `ship "<name>" is offline`. |

## Repo registry

The repo registry is owned entirely by the bridge and persisted to `repos.json`
in its data directory. Ships know nothing about it — a ship is told a clone URL,
never a repo name to look up.

### `GET /repos`

```ts
{ name: string; url: string; provider: string }[]
```

### `POST /repos`

```ts
{ name: string; url: string; provider?: string }   // request
```

`provider` defaults to `"custom"` when omitted. Returns `201` with the stored
`Repo`.

| Status | Cause |
| --- | --- |
| `422` | `name` or `url` missing. |
| `400` | `invalid repo` — e.g. `name` is not a valid fleet identifier. |
| `409` | `repo already registered: <name>`. |

### `DELETE /repos/:name`

Responds `{ ok: true }`.

| Status | Cause |
| --- | --- |
| `400` | Invalid repo identifier. |
| `404` | `repo not found: <name>`. |

Deleting a repo does not touch any workspace already cloned from it.

## Workspaces

### `GET /workspaces`

| Query | Type | Default | Meaning |
| --- | --- | --- | --- |
| `active` | string | absent | `"true"` → only active, `"false"` → only inactive. Any other value is treated as no filter. |

Before answering, the bridge re-fetches `GET /workspaces` from every online ship
and refreshes its index, so the list reflects the ships' current view rather
than only the event stream.

```ts
// BridgeWorkspaceSummary
{
  repoName: string;
  name: string;
  branch: string;
  active: boolean;
  agent: AgentStatus | null;
  ship: string;      // the extra field
}[]
```

### `GET /workspaces/:repo/:name`

Proxied live to the owning ship, so the diff is fresh. The response is the
ship's `WorkspaceStatus` union with `ship` added to whichever variant is
returned — meaning `inactive` responses carry `ship` here even though they do
not on a ship.

```ts
{ state: "inactive"; repoName; name; branch; ship: string }
{ state: "active"; repoName; name; branch; diff; agent; issue: null;
  mergeRequest: null; ship: string }
```

The bridge re-validates the ship's response: an unparseable status, or one whose
`repoName`/`name` differ from the request, is a `502`.

### `GET /workspaces/:repo/:name/diff`

Same query parameters as the ship's diff route (`staged`, `stat`, `nameOnly`,
`range`, `paths`, `includeUntracked`), forwarded unchanged. Returns raw diff
text.

### `POST /workspaces`

```ts
// request body — all four fields required
{ ship: string; repoName: string; name: string; branch: string }
```

`ship` names the target host and `repoName` must be a **registered repo**; the
bridge looks up its clone URL and calls the ship's `POST /workspaces` with
`{url, repoName, name, branch}`. Returns `201` with the ship's
`WorkspaceSummary` plus `ship`.

| Status | Cause |
| --- | --- |
| `422` | A body field is missing. |
| `400` | Invalid repo/workspace identifier; `unknown ship: <ship>`; `unknown repo: <repoName>`. |
| `503` | `ship "<ship>" is offline`. |
| `409` | `workspace already exists: <repo>/<name>`; a create for that key is already in progress; the key's create outcome is indeterminate; the target ship was removed mid-request. |
| `502` | The ship returned no data, an invalid summary, or a different workspace identity. |

:::caution
If the create request to the ship fails at the transport layer, the bridge
cannot know whether the clone happened. It marks the key *indeterminate* and
keeps the reservation, so retries return `409` with
`workspace creation outcome is unknown: <key> on ship "<ship>"; wait for
confirmation or remove that ship to clear the reservation`. The reservation
clears itself when the ship reports the workspace, or when that ship is
deregistered.
:::

### `POST /workspaces/:repo/:name/branch`

```ts
{ branch: string }   // request
{ ok: true }         // response
```

### `POST /workspaces/:repo/:name/activate`, `/deactivate`, and `DELETE /workspaces/:repo/:name`

No request body; each responds `{ ok: true }` and forwards to the owning ship.

## `WS /events`

A read-only fleet-wide stream. Anything the client sends is ignored. On connect
the bridge sends an aggregate `sync` built from its ownership index, then
republishes each ship's events.

```ts
{ type: "sync"; at: string; workspaces: BridgeWorkspaceSummary[] }
{ type: "workspace.created" | "workspace.branch_changed"
      | "workspace.activated" | "workspace.deactivated"
      | "workspace.agent_status_changed" | "workspace.removed";
  at: string; workspace: BridgeWorkspaceSummary }
```

Two differences from a ship's `/events`:

- There is **no top-level `ship` field**. The emitting ship is on each workspace
  instead (`workspace.ship`, `workspaces[].ship`).
- `sync` and `workspace.removed` from any ship are republished as a fresh
  aggregate `sync` snapshot rather than forwarded as-is. Ship registration and
  deregistration also publish a snapshot.

An event for a workspace the emitting ship does not own (per the index) is
dropped rather than republished.

## `WS /workspaces/:repo/:name/terminal`

A dumb bidirectional pipe to the owning ship's terminal WebSocket. The bridge
does not emulate a terminal; it revalidates each client frame against the
webterm protocol and forwards it.

| Behavior | Detail |
| --- | --- |
| Unknown or offline workspace | The bridge cannot send an HTTP status once the socket is open, so it sends `{"type":"exit","code":1}` and closes — the same convention a ship uses for a busy session. |
| Buffering | Client frames sent before the upstream socket opens are buffered so the browser's first `init` is never lost. |
| Buffer cap | More than 256 KiB pending closes both sockets with `1009` / `Terminal buffer limit exceeded`. |
| Binary frame (either direction) | Closes both sockets with `1003` / `Binary terminal messages are not supported`. |
| Undecodable client frame | Closes both sockets with `1008` / `Invalid terminal message`. |
| Upstream close | The ship's close code and reason are propagated to the client. |
| Client close | Propagated upstream, which releases the ship's one-terminal-per-workspace guard. |

The socket's max payload is 1,572,992 bytes, matching the ship's.
