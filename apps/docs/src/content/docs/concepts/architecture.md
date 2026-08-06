---
title: Architecture
description: How ships, the bridge, the web client, and the CLI fit together.
sidebar:
  order: 1
---

Fleet is four programs shipped from one monorepo. Each one has a narrow job, and
they talk to each other over plain HTTP and WebSockets.

- **`fleet-ship`** — a host. It owns the workspaces on one machine: the git
  clones on disk, the tmux sessions behind them, and the agent status attached to
  each session.
- **`fleet-bridge`** — the fleet-wide orchestrator. It fronts any number of
  ships behind a single API and keeps a live picture of every workspace in the
  fleet.
- **`fleet-client`** — the React web GUI, plus the small Bun server that serves
  it and reverse-proxies to the bridge.
- **`fleet` (`apps/cli`)** — the unified CLI. It both *drives* the other three
  and *is* the other three: `fleet ship`, `fleet bridge`, and `fleet client
  serve` start them in-process.

## The picture

```
  browser
     │  HTTP + WS (same origin)
     ▼
┌──────────────────┐
│   fleet-client   │   serves the SPA, reverse-proxies /bridge/* to the bridge
└────────┬─────────┘
         │  HTTP + WS
         │            fleet CLI ──┐
         ▼                        │ HTTP
┌──────────────────┐  ◀───────────┘
│   fleet-bridge   │   ship roster, repo registry, routing, dedupe
└───┬──────────┬───┘
    │          │  HTTP (Eden) for commands  +  WS /events for state
    ▼          ▼
┌────────┐ ┌────────┐
│  ship  │ │  ship  │   workspaces on disk, tmux sessions, agent status
└────────┘ └────────┘
    │          │
    ▼          ▼
 <fleetDirectory>/<repo>/<name>   ← the agent works here
```

Data flows *up* the diagram over WebSockets and *down* it over HTTP. Ships never
call the bridge; the bridge dials each ship.

## The ship

A ship is one process bound to one directory. Everything it knows lives on disk
under that directory, laid out as `<fleetDirectory>/<repo>/<name>` — see
[Workspaces](/concepts/workspaces/).

It serves an HTTP + WebSocket API (Elysia, default port `4700`) with three
surfaces:

- workspace CRUD, branch switching, activate/deactivate, and the diff,
- `/events` — a read-only stream of workspace state changes,
- `/workspaces/:repo/:name/terminal` — a live terminal for one workspace.

The full route list is in the [ship API reference](/reference/ship-api/).

A ship has no database. `GET /workspaces` is a directory scan, and whether a
workspace is *active* is answered by asking tmux whether its session exists. The
only mutable in-memory state is the agent status attached to each live session.

## The bridge

The bridge exists because a ship only knows about its own machine, and nothing
stops two ships from being handed the same `<repo>/<name>`.

It gives you:

- **one endpoint.** The bridge exposes a superset of the ship's workspace API.
  Requests are routed to the owning ship automatically, so callers never name a
  ship except when creating a workspace.
- **fleet-wide uniqueness.** `<repo>/<name>` identifies a workspace across the
  *whole* fleet, not just one host.
- **a persisted roster.** Ships are registered by URL and survive a bridge
  restart.
- **a repo registry.** Clone URLs are registered once with the bridge instead of
  being passed on every create.

The bridge holds no workspace state of its own. It consumes each ship's
`/events` socket and derives a `<repo>/<name>` → ship index from what the ships
report. Detail is in [Bridge](/concepts/bridge/).

## The web client

`fleet client serve` starts a Bun server that does two things: serve the React
SPA, and reverse-proxy `/bridge/<path>` to the real bridge — WebSocket upgrades
included. The browser therefore only ever talks to its own origin, which means
the bridge needs no CORS configuration.

The GUI is a live view: it loads ships, repos, and workspaces once over HTTP,
then subscribes to the bridge's `/events` socket and applies each event to local
state. See [Events](/concepts/events/) and the
[web GUI guide](/guides/web-gui/).

## The CLI

`fleet` is a Commander CLI with five command groups:

| Command | What it does |
|---|---|
| `fleet ship` | run a ship |
| `fleet bridge` | run a bridge |
| `fleet client` | drive a ship or the bridge; `fleet client serve` runs the GUI |
| `fleet launch` | bring a whole fleet up in one process from `fleet-config.yaml` |

Agents run a separate binary, `fagent`, from inside a workspace — for status
reporting and for working with the repo's issues, PRs, and CI through the bridge.
See the [fagent reference](/reference/fagent/).

`fleet client` commands talk to a single ship by default (`--url`, default
`http://localhost:4700`) and to the bridge for fleet-wide operations
(`--bridge-url`, default `http://localhost:4800`). See the
[CLI reference](/reference/cli/).

## Typed HTTP, raw WebSockets

The HTTP hops are Elysia servers consumed through an [Eden
Treaty](https://elysiajs.com/eden/overview.html) client, so the bridge's calls
into a ship — and the browser's calls into the bridge — are typed end to end
from the server's own route definitions. Nothing is hand-written twice.

The WebSocket payloads can't rely on that, because the receiver decodes them
from raw text. Those shapes live in `fleet-protocol` as zod schemas with the
TypeScript types inferred from them, so the validator and the type can't drift.
See the [protocol reference](/reference/protocol/).

## Trust model

The bridge authenticates every request. Callers are one of three principals — a
logged-in **user**, a **ship** presenting its `shipToken`, or a **ship-agent**
running inside a workspace — and each is confined to the routes it needs: a user
reaches everything (with a `member`/`admin` split on user management and on
registering or removing ships), a ship reaches only the armory, an agent only the
repo routes. Credentials are bearer tokens; the GUI proxy forwards the header
unchanged.

A ship authenticates its callers only when it is given a `bridgeToken` (its
`FLEET_BRIDGE_TOKEN`). Without one, every ship route answers anyone who can
reach the port.

Full detail — where each secret lives, how the first admin is created, and what
`--insecure-no-auth` gives up — is in [authentication](/guides/authentication/).

:::caution
Bearer tokens travel in a plain header, so anyone who can read the traffic can
replay them: run Fleet behind TLS or on a trusted network.

A ship can run arbitrary code from any repo it is asked to clone, and its
terminal endpoint is a shell on the host. Do not expose a ship port to an
untrusted network, authenticated or not.
:::

## One process or many

Nothing requires these to be separate processes. `fleet launch` reads a
[`fleet-config.yaml`](/reference/fleet-config/) and starts a bridge, any number
of local ships, and the GUI in a single Bun process, registering each ship with
the bridge as it comes up. Ships marked `source: remote` are registered by URL
instead of spawned. That's the fastest way to get a working fleet — see the
[Quickstart](/start/quickstart/).
