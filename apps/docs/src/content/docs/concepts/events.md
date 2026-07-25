---
title: Events
description: The /events WebSocket, how snapshots and incremental updates work, and how the bridge stays in sync.
sidebar:
  order: 5
---

Both a ship and the bridge serve a read-only `/events` WebSocket. It is how
everything downstream — the bridge, the web GUI — learns that a workspace was
created, activated, or that an agent changed what it's doing, without polling.

The stream is strictly one-directional. Anything a client sends is ignored.

## Snapshot, then deltas

Every connection follows the same shape:

1. On open, the server sends a **`sync`** event containing the full current list
   of workspaces.
2. From then on it streams one event per state change.

That means a consumer never needs a separate "load the list first" HTTP call to
be correct, and a reconnect is self-healing: the new `sync` replaces whatever
stale state the consumer had. The web GUI leans on this — a `sync` clears its
stream-error banner.

Building a ship's snapshot takes a directory scan, so changes that happen during
it are buffered and flushed immediately after the `sync` goes out. Ordering is
preserved; a client never sees a change that the snapshot it just received
already reflects.

## The ship's event types

Every event a ship emits carries the emitting ship's `name` (as `ship`) and an
ISO 8601 `at` timestamp. Change events carry a complete `WorkspaceSummary`, not
a delta:

| Type | Emitted when |
|---|---|
| `sync` | a client connects — carries `workspaces[]` |
| `workspace.created` | a clone finished; the workspace starts inactive |
| `workspace.branch_changed` | the branch was switched |
| `workspace.activated` | a tmux session was started |
| `workspace.deactivated` | the tmux session was killed |
| `workspace.agent_status_changed` | an agent registered a session or updated its status |
| `workspace.removed` | the workspace was deleted |

Because each change event carries the whole summary, applying the stream is
trivial: replace the row with a matching `<repo>/<name>`, insert it if it's new,
delete it on `workspace.removed`, and replace everything on `sync`. That is
literally all the client's reducer does.

The union is a zod discriminated union in `fleet-protocol`, and consumers decode
raw frames through `decodeFleetEvent`, which parses and validates in one call.
Anything that doesn't match is dropped rather than trusted. Field-level detail
is in the [protocol reference](/reference/protocol/).

:::note
`workspace.removed` reports the workspace's last-known branch, captured before
the directory was deleted, and `active: false`. It describes what went away, not
a live object.
:::

## How the bridge consumes ship events

The bridge holds one connection object per ship. That object owns:

- an Eden HTTP client for commands,
- the raw `/events` socket,
- this ship's last-known workspace map, keyed `<repo>/<name>`,
- the `online`/`offline` status and the reconnect loop.

Each decoded event is applied to that ship's own map first (`sync` clears and
refills it; `workspace.removed` deletes; everything else upserts), then handed
to the fleet manager, which updates the fleet-wide ownership index described in
[Bridge](/concepts/bridge/).

Two identity rules keep a misconfigured ship from corrupting the fleet view:

- A connection registered without a known name adopts the name from the first
  `sync` it sees, and ignores anything else until then.
- Once it has a name, events claiming a *different* `ship` are discarded.

Events from a connection the bridge has not yet adopted into the fleet — a probe
opened by `POST /ships` that hasn't passed its conflict checks — never reach the
index at all.

## The bridge's own stream

The bridge re-publishes to its own `/events` subscribers, but the payloads are
not identical to a ship's:

- there is no top-level `ship` field; instead **each workspace** carries the
  `ship` that hosts it,
- a change event is only forwarded if the emitting ship is the confirmed owner
  of that workspace in the index,
- `sync` and `workspace.removed` from a ship are turned into a **fresh fleet-wide
  `sync`** rather than being forwarded as-is, because both can change ownership.

Roster changes publish a fresh `sync` too: adding or removing a ship changes
which workspaces exist fleet-wide, and a full snapshot is the simplest correct
way to say so.

## Consuming it from a browser

The GUI subscribes through the fleet-client server's `/bridge/events` proxy, so
the socket is same-origin. On close it reconnects with exponential backoff
(doubling from one second, capped at 30 seconds) and the `sync` that follows
repairs whatever it missed while disconnected.

Frames that aren't text, or that don't parse as an event, are dropped.

## Known limitations

Two rough edges are recorded in the repo's `BACKLOG.md` and are worth knowing
about before you rely on the stream at scale.

**Snapshot size.** The web client's WebSocket proxy buffers upstream frames that
arrive before the browser-facing socket is open, and applies the terminal
protocol's 256 KiB pending-bytes limit to them. The bridge sends the whole fleet
snapshot as a single frame, and agent status descriptions are not length-bounded
at the API boundary, so a legitimately large `sync` can exceed that limit and
trigger a permanent reconnect loop. Event-stream limits need to be defined
separately from terminal limits, and snapshots chunked or paginated.

**Backpressure.** The bridge broadcasts to its subscribers without checking send
results or configuring WebSocket backpressure. A slow browser can miss an update
while staying connected, leaving its workspace list stale — and because a fresh
snapshot is only sent on connect, nothing repairs it until the socket is closed
and reopened.

Neither affects small fleets, and both are transport-level: the event contract
itself is unchanged by fixing them.
