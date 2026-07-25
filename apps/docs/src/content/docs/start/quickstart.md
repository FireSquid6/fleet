---
title: Quickstart
description: Bring up a bridge, a ship, and the GUI, then create and activate your first workspace.
sidebar:
  order: 3
---

This walks through a first run on a single machine: scaffold a config, launch
the fleet, register a repo, create a workspace, activate it, and watch it in the
GUI. It assumes `fleet` is on your `PATH` — see
[Installation](/start/installation/).

## 1. Scaffold a config

Pick (or create) a directory to hold the fleet's data, then:

```bash
fleet launch init
```

That writes `./fleet-config.yaml`. Use `--config-path <path>` to write it
somewhere else, and `--force` to overwrite an existing file — without it, init
refuses rather than clobbering your config.

## 2. Read the generated config

```yaml
# fleet-config.yaml — configuration for `fleet launch`.
# Every section is optional; only the sections present are started.

# The fleet-wide bridge that coordinates ships and serves the fleet API.
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: my-fleet-bridge

# The web gui. Proxies to the bridge above by default.
gui:
  port: 3000
  # bridgeUrl: http://localhost:4800  # defaults to the local bridge

# Ships that host workspaces. Each key is the ship's default name.
ships:
  ship-a:
    # source: local (the default) spawns the ship in this process.
    source: local
    fleetDirectory: ./fleet/ship-a
    port: 4700
    # name: ship-a  # defaults to the key above
```

What each section means:

- **`bridge`** — the orchestrator. `dataDirectory` is where `ships.json` and
  `repos.json` are persisted (resolved to an absolute path, created if
  missing). Omit the whole section and no bridge is started; write a bare
  `bridge:` with no body and you get the defaults (`./.fleet/bridge`, port
  `4800`, name `bridge`).
- **`gui`** — the React dashboard. `port` is optional; omit it and Bun picks a
  free one. `bridgeUrl` is the bridge the GUI proxies to, defaulting to the
  bridge launched above it. A `gui` with neither a `bridge` section nor a
  `bridgeUrl` is a config error.
- **`ships`** — a map, not a list. Each key names a ship and supplies its
  defaults: `name` falls back to the key, and `fleetDirectory` falls back to
  `./fleet/<key>`. `source: local` (the default when omitted) spawns the ship in
  the same process; `source: remote` with a `url` registers an already-running
  ship elsewhere instead of starting one. Two local ships may not share a port.

The full schema is in the [fleet-config reference](/reference/fleet-config/).

## 3. Launch

```bash
fleet launch
```

One process starts every configured section, in order: bridge, then each ship,
each registered with the bridge as it comes up, then the GUI.

```
fleet-bridge "my-fleet-bridge" listening on http://localhost:4800
fleet-ship "ship-a" listening on http://localhost:4700
registered ship "ship-a" (http://localhost:4700) with the bridge
Started client on http://localhost:3000/, forwarding to http://localhost:4800
```

Ctrl-C stops all of it. Pass `--config-path <path>` if your config is not at
`./fleet-config.yaml`.

Ship registration is best-effort: if a ship cannot be reached, `fleet launch`
warns and carries on with the rest of the fleet.

On disk you now have `./fleet/ship-a/` (the ship's workspace root, holding
`atlas.json`) and `./.fleet/bridge/` (the bridge's roster and repo registry).

## 4. Register a repo

Leave `fleet launch` running and open a second terminal. The bridge keeps a repo
registry — the set of repos the fleet can clone from:

```bash
fleet client repos add fleet https://github.com/firesquid6/fleet.git
fleet client repos ls
```

```
NAME   URL                                      PROVIDER
fleet  https://github.com/firesquid6/fleet.git  custom
```

The first argument is the repo *name*, which is also the directory a clone lands
under on a ship. `-p, --provider <provider>` records where it is hosted (e.g.
`github`); it defaults to `custom`.

`fleet client` reaches the bridge at `http://localhost:4800` and a ship at
`http://localhost:4700` unless you say otherwise. Both are options on the
`client` command itself, so they go *before* the subcommand:

```bash
fleet client --bridge-url http://localhost:4800 repos ls
fleet client --url http://localhost:4700 ls
```

## 5. Create a workspace

```bash
fleet client create fleet first-task -u https://github.com/firesquid6/fleet.git -b quickstart
```

```
created workspace fleet/first-task on branch quickstart
```

The arguments are the repo name and the workspace name; `-u, --url` and
`-b, --branch` are both required. The ship clones the URL into
`./fleet/ship-a/fleet/first-task` on the branch you named. Neither name may
contain `/` or `\` — they are path segments.

:::note
`fleet client create` talks to a **ship** directly, so it takes the clone URL
itself and does not consult the bridge's repo registry. The registry is what the
GUI (and the bridge's own `POST /workspaces`) uses: there you pick a registered
repo plus a target ship, and the bridge supplies the URL. Keep the name you pass
here identical to the registered repo name so both views agree.
:::

List what exists:

```bash
fleet client ls
fleet client ls --wide
```

```
SHIP    REPO   NAME        BRANCH      ACTIVE
ship-a  fleet  first-task  quickstart  no
```

`--wide` asks the bridge for every workspace in the fleet and adds the owning
ship; plain `ls` asks one ship. `--active` / `--inactive` filter, and `--json`
prints raw JSON.

## 6. Activate it

A workspace is *active* when it has a running tmux session. That session is what
an agent runs in, and what the browser terminal attaches to.

```bash
fleet client activate fleet first-task
fleet client status fleet first-task
```

```
repo:   fleet
name:   first-task
branch: quickstart
state:  active
ship:   ship-a
diff:   +0 -0 (0 commits ahead)
```

`status` only reports the ship, diff, and agent fields while a workspace is
active — an inactive one has just a repo, name, branch, and state.

## 7. Open the GUI

Visit `http://localhost:3000`. The overview lists every workspace the bridge
knows about, live: the GUI subscribes to the bridge's event stream, which is fed
by each ship's, so creates, branch switches, activations, and agent status
updates appear without a refresh.

From there:

- `/repos` — the repo registry, and where you register a new repo
- `/ships` — the ship roster, and where you register a ship by URL
- `/repos/fleet/workspaces/first-task` — the workspace: its diff, and a live
  terminal on the tmux session

Start your agent harness in that terminal. Told to work in a fleet, it picks up
the `fleet-agent` skill and reports its own status back with `fleet agent init`
and `fleet agent status`, which shows up on the dashboard within the same
event stream. See [Running agents](/guides/running-agents/).

## 8. Clean up

```bash
fleet client deactivate fleet first-task
fleet client rm fleet first-task
```

`deactivate` kills the tmux session and drops the agent status; `rm` kills the
session if needed and deletes the clone from disk. Uncommitted or unpushed work
in the workspace goes with it.

## Next

- [Architecture](/concepts/architecture/) — what the bridge and ships are doing
  behind these commands.
- [Configuring a fleet](/guides/configuring-a-fleet/) — more than one ship, and
  remote ones.
- [CLI reference](/reference/cli/) — every command and flag.
