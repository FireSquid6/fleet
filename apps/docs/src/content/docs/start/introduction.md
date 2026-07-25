---
title: Introduction
description: What Fleet is, the problem it solves, and how its pieces fit together.
sidebar:
  order: 1
---

Fleet runs coding agents in isolated git workspaces, on one machine or across
many. Each workspace is a full clone of a repo on its own branch, backed by a
headless tmux session you can attach to from a browser, and reported on by a
live event stream.

## The problem

Running more than one coding agent against a single checkout does not work.
Two agents editing the same working tree stomp on each other's edits, share one
branch, and produce a diff nobody can attribute. The usual fix — cloning the
repo by hand into a scratch directory, starting a tmux session, and remembering
which pane belongs to which task — stops scaling at about three agents, and
stops working entirely once the agents live on more than one machine.

Fleet makes that arrangement a first-class thing:

- **Isolation.** Every workspace is its own clone at
  `<fleetDirectory>/<repo>/<name>`, on its own branch. Agents never share a
  working tree.
- **Visibility.** Every workspace reports its branch, whether it is active, its
  diff against `HEAD`, and what its agent is doing right now. Changes are pushed
  over a WebSocket rather than polled.
- **Reach.** One bridge fronts many ships, so a fleet can span machines while
  still presenting a single API and a single dashboard.

## The pieces

### Ship

A ship (`packages/fleet-ship`, `fleet ship`) owns the workspaces on one machine.
It creates them by cloning, switches their branches, activates and deactivates
them by starting and killing tmux sessions, deletes them, and serves the raw
`git diff` for each one. It listens on port `4700` by default and exposes an
HTTP + WebSocket API: `/workspaces/...`, `/events`, `/system-resources`, and a
per-workspace `/workspaces/:repo/:name/terminal` socket that attaches to the
workspace's tmux session.

On startup a ship also writes `atlas.json` to the root of its fleet directory.
Because workspaces live two levels below that root, an agent inside one can walk
up the tree, find the file, and learn which port to talk to. See
[Ships](/concepts/ships/).

### Bridge

The bridge (`packages/fleet-bridge`, `fleet bridge`) is the fleet-wide
orchestrator. It holds a roster of ships, connects to each one's `/events`
socket, and maintains a `<repo>/<name>` → ship index it uses to route every
mutation to the owning ship. Its workspace API is a superset of the ship's, with
the owning ship stamped onto each response, plus two registries of its own:
ships and repos. It listens on port `4800` by default and persists
`ships.json` / `repos.json` to its data directory. See
[Bridge](/concepts/bridge/).

### Client (web GUI)

The client (`packages/fleet-client`, `fleet client serve`) is a React app served
by Bun. It reverse-proxies `/bridge/*` to a real bridge — including WebSocket
upgrades, so terminals work through it — which means the bridge needs no CORS
configuration. The GUI lists workspaces fleet-wide, registers repos and ships,
shows per-workspace diffs, and renders a live terminal for any active workspace.
See [Web GUI](/guides/web-gui/).

### CLI

`fleet` is the single entry point for all of it:

| Command | Does |
| --- | --- |
| `fleet ship` | run a ship on this machine |
| `fleet bridge` | run a bridge |
| `fleet client` | talk to a ship or bridge; `fleet client serve` runs the GUI |
| `fleet launch` | bring up bridge + ships + GUI from `fleet-config.yaml` |
| `fleet agent` | the reporting commands agents use from inside a workspace |

The full surface is in the [CLI reference](/reference/cli/).

### The agent contract

Fleet does not run the agent for you — you start your harness inside the
workspace's terminal. What Fleet defines is how that agent reports back.

A ship installs a `fleet-agent` skill (and, where the provider supports one, a
startup plugin) into each agent provider's config directory when it boots;
`fleet ship plugin doctor` shows the state of those installs. The skill tells
the agent it owns its clone end to end — pull, commit, and push its own branch —
and that it must keep its status current with two commands:

```bash
fleet agent init --model <model> --provider <provider> --harness <harness>
fleet agent status <state> -d "<what you're doing right now>"
```

`<state>` is one of `idle`, `planning`, `building`, `verifying`, `awaiting`.
Both commands locate the surrounding workspace via `atlas.json` and POST to the
ship, which turns the update into a `workspace.agent_status_changed` event that
reaches every dashboard. See [Agents](/concepts/agents/) and
[Running agents](/guides/running-agents/).

## Where to go next

- [Installation](/start/installation/) — what you need on the machine, and how
  to get the `fleet` binary.
- [Quickstart](/start/quickstart/) — a fleet running, with a workspace in it,
  in a few commands.
- [Architecture](/concepts/architecture/) — how ships, the bridge, and the
  event stream fit together.
