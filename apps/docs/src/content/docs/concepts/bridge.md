---
title: The bridge
description: The fleet-wide orchestrator that fronts many ships behind one API.
sidebar:
  order: 4
---

The bridge is a single endpoint in front of any number of [ships](/concepts/ships/).
It exposes a superset of the ship workspace API with the owning ship abstracted
away — routing is automatic — but kept visible: every workspace it returns is
annotated with the `ship` that hosts it.

```bash
fleet bridge --port 4800 --name my-bridge --data-directory ./.fleet-bridge
```

Like a ship, it is configured entirely from flags.

## What the bridge owns, and what it doesn't

The bridge owns exactly two pieces of durable state, both persisted as JSON in
its data directory:

- **`ships.json`** — the roster: each ship's name and URL.
- **`repos.json`** — the repo registry: name, clone URL, provider.

It owns **no** workspace state. Workspaces live on ships, and the bridge's view
of them is derived, in memory, from what the ships report over their `/events`
sockets. Restart the bridge and that view is rebuilt from scratch.

Both files are written atomically (temp file, `fsync`, rename) and every store
operation is serialized through a queue, so a crash mid-write can't leave a
half-written roster.

## The ship roster

A ship is registered by URL only:

```bash
fleet client ships add http://ship-b.internal:4700
```

The bridge connects to that URL's `/events` socket, waits up to five seconds for
the first `sync` event, and takes the ship's name from it. If the ship doesn't
answer in time, the registration fails with `502` — you cannot register a ship
that isn't up.

Before adopting it, the bridge checks two things:

- the discovered name is not already registered (`409` if it is),
- none of the ship's workspaces collide with a `<repo>/<name>` already owned
  elsewhere in the fleet (`409`, listing the conflicts).

Only then is the connection adopted, the roster persisted, and a fresh snapshot
published to every `/events` subscriber.

At startup the bridge loads the roster, connects to every ship, and waits for
each to sync (or time out). If two *reachable* ships turn out to hold the same
`<repo>/<name>`, the bridge prints the conflict and exits rather than starting
in an ambiguous state.

## Routing and the ownership index

The bridge keeps one map: `<repo>/<name>` → owning ship name. Every ship
connection separately keeps its own last-known workspace map, and the index is
derived from those. Routing a request is a single lookup.

Claiming a key is first-writer-wins. If a second ship later reports a workspace
that is already owned, the bridge logs a warning and ignores the newcomer rather
than flip-flopping ownership — the fatal duplicate check only runs at startup,
so a duplicate that appears at runtime degrades instead of taking the fleet
down.

When a ship's `sync` arrives, its contribution to the index is replaced
wholesale: keys it no longer reports are released, keys it reports are claimed.
Releasing a key looks for a successor — another connection that still has the
workspace, preferring an online one — before dropping it entirely.

## Uniqueness

The result of all of that is the bridge's central guarantee: **`<repo>/<name>`
identifies exactly one workspace across the whole fleet.** That is what lets
every bridge route except create omit the ship — activating, deactivating,
switching branches, reading a diff, deleting, and attaching a terminal all
address a workspace by `<repo>/<name>` alone, and the bridge finds the host.

Create is the exception, because there is nothing to look up yet: its body names
the target ship.

### Create is guarded

Between sending a create to a ship and seeing the resulting `workspace.created`
event, the bridge holds a *reservation* on the key so a second create can't race
in. A concurrent create for the same key is rejected with `409`.

If the create's outcome is genuinely unknown — the request failed at the
transport level, or the ship returned something unusable — the reservation is
kept in an `indeterminate` state instead of being released. Later creates for
that key are refused with an explanation until the ship confirms the workspace
(which clears the reservation) or the ship is removed from the fleet. This is
deliberate: silently retrying could produce two clones of the same name on
different hosts.

On success the bridge inserts the new workspace into its index optimistically,
so a `GET` immediately after a create doesn't race the event stream. The
`workspace.created` event that follows overwrites it with identical data.

## Offline ships

A ship's status is simply whether the bridge currently has an open `/events`
socket to it. When the socket drops, the connection is marked `offline` and
reconnects with exponential backoff — doubling from one second, capped at 30
seconds, with jitter. A command that fails at the network level also flips the
connection offline immediately, without waiting for the socket to notice.

While a ship is offline:

- `GET /ships` reports it with `status: "offline"`,
- mutations routed to it return `503`,
- it contributes nothing to `GET /workspaces` (the merged list only queries
  online ships),
- `GET /system-resources` reports it with `resources: null` rather than failing
  the whole aggregate.

Nothing is deleted. When the ship comes back, its `sync` restores its
workspaces to the index.

Removing a ship (`DELETE /ships/:name`) closes the connection, releases every
key it owned, drops its reservations, persists the roster, and publishes a fresh
snapshot. It does not touch anything on the ship itself.

## The repo registry

A ship's create endpoint takes a clone URL. The bridge's does not — it takes a
registered repo name and looks the URL up:

```bash
fleet client repos add api-gateway https://github.com/acme/api-gateway.git
```

`POST /workspaces` on the bridge then only needs `{ ship, repoName, name,
branch }`, and the bridge supplies the clone URL from the registry. An unknown
repo name is a `400`.

A repo record is `{ name, url, provider }`. The name must be a fleet identifier,
because it is also the directory the clone lands under on the ship. `provider`
is free text describing where it is hosted and defaults to `"custom"`.

Registering a name that already exists is a `409`; the registry never silently
overwrites. Removing a repo removes only the registry entry — existing
workspaces cloned from it are untouched, and their `repoName` keeps working.

See [Managing repos](/guides/managing-repos/).

## Aggregate views

`GET /workspaces` merges the live list from every online ship, refreshes the
index from what came back, dedupes by owner, and annotates each row with its
ship.

`GET /workspaces/:repo/:name` is different: it is proxied live to the owning
ship so the [diff summary](/concepts/workspaces/) is fresh. The bridge validates
the response and rejects a ship that returns a workspace identity nobody asked
for.

The terminal WebSocket is a dumb bidirectional pipe to the owning ship's
terminal endpoint — see [Terminals](/concepts/terminals/).

The complete route list is in the
[bridge API reference](/reference/bridge-api/).
