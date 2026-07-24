---
title: Ships
description: The per-machine host that owns workspaces, and how agents inside them find it.
sidebar:
  order: 3
---

A ship is one process that owns the workspaces on one machine. It is the only
component that touches the filesystem, spawns git, or talks to tmux. Everything
else in Fleet is a client of a ship.

## Configuration

A ship is configured entirely from flags — there is no config file:

```bash
fleet ship \
  --port 4700 \
  --name ship-a \
  --fleet-directory ./fleet
```

| Flag | Default | Meaning |
|---|---|---|
| `--port`, `-p` | `4700` | port the HTTP + WebSocket API listens on |
| `--name`, `-n` | `ship` | human-facing name of this ship |
| `--fleet-directory`, `-f` | `./fleet` | directory holding all workspaces |

The values are validated against a shared schema before the ship starts, so a
bad name or a non-integer port fails immediately rather than halfway through
startup.

### The fleet directory

The fleet directory is the ship's entire world. On startup the ship creates it
if missing and resolves it to its canonical path with `realpath`, and from then
on every workspace path is required to be a strict descendant of that canonical
root. Workspaces are laid out as `<fleetDirectory>/<repo>/<name>` — see
[Workspaces](/concepts/workspaces/).

Because the ship holds no database, the directory *is* the state. Copying it
somewhere else and pointing a ship at it works; deleting it wipes the ship.

### The name

The ship's name is a [fleet identifier](/reference/protocol/) — at most 128
UTF-8 bytes, no path separators, no control characters. It is not just a label:

- it is stamped on every event the ship emits on `/events`,
- it appears as `ship` on an active workspace's detailed status,
- it is the key the [bridge](/concepts/bridge/) registers the ship under.

The bridge does not take a name when you register a ship. It connects to the URL
you give it and learns the name from the ship's first `sync` event. Two ships
with the same name cannot both join a fleet, so names must be unique across a
fleet even though nothing local enforces that.

## Running more than one ship on a machine

Nothing stops it — give each ship its own port and its own fleet directory. That
is exactly what `fleet launch` does when a `fleet-config.yaml` declares several
local ships, and it refuses to start if two of them claim the same port. See
[Configuring a fleet](/guides/configuring-a-fleet/).

## `atlas.json` — how an agent finds its ship

An agent running inside a workspace has no environment handed to it. All it
knows is its working directory. `atlas.json` is how it gets from there to an
API it can call.

On startup the ship writes the file to the **root of its fleet directory**:

```json
{
  "port": 4700
}
```

The port written is the port the server actually bound, not the requested one.

Because workspaces live at `<fleetDirectory>/<repo>/<name>`, discovery is a walk
up the tree:

1. Start at the current directory. Look for `atlas.json`.
2. Not there? Move to the parent and try again, until the filesystem root.
3. When it is found, the path from that directory down to where you started
   gives the workspace identity: the first segment is the repo, the second is
   the workspace name. Fewer than two segments means you're in the fleet
   directory but not in a workspace.
4. The ship is then reachable at `http://localhost:<port>`.

That is what `fleet agent in-workspace` does, and what every other `fleet agent`
command does before it makes a request. See [Agents](/concepts/agents/).

`atlas.json` is written atomically — a private temp file, then a rename — and
the ship refuses to replace it if something has turned it into a symlink.

:::note
The URL derived from `atlas.json` is always `localhost`. Discovery is for
processes running *on the ship*, which is the only place an agent runs. Remote
callers use the bridge.
:::

## What else a ship does at startup

Before it starts serving, a ship installs the `fleet-agent` skill and the
per-harness startup plugins into the current user's home directory, so agents
launched on this machine already know the reporting protocol. Failures there are
warnings, not fatal — the ship still comes up. See
[Agents](/concepts/agents/) and
[Agent integrations](/guides/agent-integrations/).

## Host resources

`GET /system-resources` returns a point-in-time snapshot of the host: uptime, OS
and kernel details, CPU model, core count, a briefly sampled busy fraction, load
averages, and memory totals. The bridge re-exposes it per ship and as an
aggregate across the fleet, which is what the GUI's ships view is built on.

## Talking to a ship directly

`fleet client` commands point at a single ship by default:

```bash
fleet client --url http://localhost:4700 ls
```

This bypasses the bridge entirely — no routing, no fleet-wide uniqueness check,
no repo registry (you pass the clone URL yourself). It is the right tool for
debugging one host. For anything fleet-wide, go through the bridge. See
[Managing ships](/guides/managing-ships/) and the
[ship API reference](/reference/ship-api/).
