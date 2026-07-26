---
title: CLI reference
description: Every fleet command, argument, and option, with its default.
sidebar:
  order: 1
---

The `fleet` binary is a Commander.js CLI that mounts five top-level command
groups:

| Command | Purpose |
| --- | --- |
| `fleet client` | Drive a ship (or the fleet, via a bridge) over HTTP. |
| `fleet ship` | Run a Fleet Ship host, and manage agent integrations. |
| `fleet bridge` | Run a Fleet Bridge. |
| `fleet launch` | Bring a whole fleet up from a `fleet-config.yaml`. |

Agent self-reporting and the repo/PR/CI commands agents run from inside a
workspace live in a separate, agent-facing binary, `fagent` — documented on its
own [fagent CLI reference](/reference/fagent/) page.

There is no terminal/WebSocket command; terminals are reached through the web
GUI or the raw API (see [terminals](/concepts/terminals/)).

## `fleet client`

`fleet client` owns two connection options that its subcommands inherit. They
belong to `fleet client` itself, so they go before the subcommand name:
`fleet client --url 4701 ls`.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--url` | `<baseUrl>` | `http://localhost:4700` | Base URL of the Fleet Ship host. |
| `--bridge-url` | `<url>` | `http://localhost:4800` | Base URL of the Fleet Bridge, used by fleet-wide commands. |

Both values are normalized before use:

| Input | Result |
| --- | --- |
| `4700` (digits only) | `http://localhost:4700` |
| `localhost:4700` | `http://localhost:4700` |
| `http://foo:4700` or `https://…` | unchanged |

Leading/trailing whitespace and trailing `/` characters are stripped in all
cases.

Which endpoint a subcommand talks to is fixed per subcommand:

| Talks to `--url` (ship) | Talks to `--bridge-url` (bridge) |
| --- | --- |
| `ls` (without `--wide`), `status`, `create`, `branch`, `activate`, `deactivate`, `rm` | `ls --wide`, `ships …`, `repos …` |

### `fleet client ls`

```bash
fleet client ls [options]
```

Lists workspaces. Without `--wide` it lists one ship's workspaces; with `--wide`
it lists every workspace across the fleet via the bridge, annotated with the
owning ship.

| Option | Default | Meaning |
| --- | --- | --- |
| `--active` | off | Only show active workspaces (`?active=true`). |
| `--inactive` | off | Only show inactive workspaces (`?active=false`). |
| `--wide` | off | Query the bridge instead of a single ship, and add a `SHIP` column. |
| `--json` | off | Print the raw JSON array (2-space indented) instead of a table. |

Passing both `--active` and `--inactive` prints
`fleet: --active and --inactive are mutually exclusive` and exits 1.

With no rows and no `--json`, the command prints `no workspaces`.

Table columns are `REPO  NAME  BRANCH  ACTIVE` (`ACTIVE` is `yes`/`no`), and
`SHIP  REPO  NAME  BRANCH  ACTIVE` under `--wide`.

### `fleet client status`

```bash
fleet client status <repo> <name>
```

| Argument | Meaning |
| --- | --- |
| `<repo>` | Repo name. |
| `<name>` | Workspace name. |

Takes no options. Prints `repo:`, `name:`, `branch:` and `state:` lines. When
the state is `active` it additionally prints a `ship:` line and a `diff:` line
of the form `+<added> -<removed> (<n> commit(s) ahead)`.

### `fleet client create`

```bash
fleet client create <repoName> <name> -u <url> -b <branch>
```

| Argument | Meaning |
| --- | --- |
| `<repoName>` | Repo name — the directory the clone lands under on the ship. |
| `<name>` | Workspace name. |

| Option | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `-u, --url` | `<url>` | yes | none | Git clone URL. |
| `-b, --branch` | `<branch>` | yes | none | Branch to check out; created off the default branch if the remote has no branch or tag by that name. |

:::caution
`-u/--url` here is the **git clone URL**, not the ship URL. The ship URL is the
`--url` option on `fleet client`, which must come before the subcommand:
`fleet client --url 4701 create repo ws -u git@… -b main`.
:::

Talks straight to a ship, so it does not require a bridge and does not consult
the bridge's repo registry. Prints
`created workspace <repo>/<name> on branch <branch>`.

### `fleet client branch`

```bash
fleet client branch <repo> <name> <newBranch>
```

| Argument | Meaning |
| --- | --- |
| `<repo>` | Repo name. |
| `<name>` | Workspace name. |
| `<newBranch>` | Branch to switch to; created if it does not exist. |

Takes no options. Prints `switched <repo>/<name> to branch <newBranch>`.

### `fleet client activate`

```bash
fleet client activate <repo> <name>
```

Starts the workspace's tmux session. Arguments `<repo>` and `<name>`; no
options. Prints `activated <repo>/<name>`.

### `fleet client deactivate`

```bash
fleet client deactivate <repo> <name>
```

Kills the workspace's tmux session. Arguments `<repo>` and `<name>`; no options.
Prints `deactivated <repo>/<name>`.

### `fleet client rm`

```bash
fleet client rm <repo> <name>
```

Deletes the workspace (its session is killed first, then its directory is
removed). Arguments `<repo>` and `<name>`; no options. Prints
`removed <repo>/<name>`.

### `fleet client ships`

Ship-roster management, always via the bridge (`--bridge-url`).

#### `fleet client ships ls`

| Option | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Print raw JSON instead of a table. |

Table columns: `NAME  URL  STATUS`, where `STATUS` is `online` or `offline`.
With no rows and no `--json`, prints `no ships`.

#### `fleet client ships add`

```bash
fleet client ships add <url>
```

| Argument | Meaning |
| --- | --- |
| `<url>` | Base URL of the ship host. Normalized with the same rules as `--url`. |

The bridge connects and learns the ship's name from its first `sync` event; the
name is not supplied by the caller. Prints
`registered ship <name> (<url>)`.

#### `fleet client ships rm`

```bash
fleet client ships rm <name>
```

| Argument | Meaning |
| --- | --- |
| `<name>` | Ship name as reported by `ships ls`. |

Prints `removed ship <name>`.

### `fleet client repos`

Repo-registry management, always via the bridge (`--bridge-url`).

#### `fleet client repos ls`

| Option | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Print raw JSON instead of a table. |

Table columns: `NAME  URL  PROVIDER`. With no rows and no `--json`, prints
`no repos`.

#### `fleet client repos add`

```bash
fleet client repos add <name> <url> [-p <provider>]
```

| Argument | Meaning |
| --- | --- |
| `<name>` | Repo name — the directory a clone lands under on the ship. |
| `<url>` | Git clone URL. |

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `-p, --provider` | `<provider>` | omitted; the bridge stores `custom` | Where the repo is hosted, e.g. `github`. |

Prints `registered repo <name> (<url>)`.

#### `fleet client repos rm`

```bash
fleet client repos rm <name>
```

| Argument | Meaning |
| --- | --- |
| `<name>` | Repo name. |

Prints `removed repo <name>`.

### `fleet client serve`

```bash
fleet client serve [--url <bridgeUrl>]
```

Serves the React web GUI, reverse-proxying `/bridge/*` to a bridge.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--url` | `<bridgeUrl>` | `http://localhost:4800` | URL of the bridge to proxy to. Normalized like every other URL option. |

:::caution
`serve`'s own `--url` names the **bridge**, and it shadows `fleet client --url`
(which names a ship). `serve` ignores `fleet client --bridge-url` entirely — set
the bridge with `fleet client serve --url …`.
:::

There is no port option: the server is started without one, so Bun picks the
port. The chosen URL is printed on start
(`Started client on <url>, forwarding to <bridgeUrl>`). To pin the port, use
`fleet launch` with a `gui.port` (see [fleet-config](/reference/fleet-config/)).

## `fleet ship`

```bash
fleet ship [options]
```

Starts the Fleet Ship HTTP + WebSocket API (see
[ship API](/reference/ship-api/)). On boot it creates and canonicalizes the
fleet directory, installs the agent skill/plugin integrations, serves the API,
and writes `atlas.json` into the fleet directory root.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `-p, --port` | `<port>` | `4700` | Port the HTTP + WebSocket API listens on. Must parse as an integer. |
| `-n, --name` | `<name>` | `ship` | Human-facing name of this ship. Must be a valid [fleet identifier](/reference/protocol/). |
| `-f, --fleet-directory` | `<dir>` | `./fleet` | Directory holding all workspaces, laid out as `<dir>/<repo>/<name>`. Resolved to an absolute path. |

A non-integer `--port` is rejected by Commander with `must be an integer`. Any
other startup failure prints `fleet-ship: <message>` and exits 1.

On success it prints
`fleet-ship "<name>" listening on http://localhost:<port>`.

### `fleet ship plugin doctor`

```bash
fleet ship plugin doctor
```

Read-only. Takes no arguments or options. For each provider — `claude-code`,
`opencode`, `copilot`, `codex`, in that order — reports the provider CLI
(`claude` / `opencode` / `copilot` / `codex`) resolved on `PATH`, the state of
the `fleet-agent` skill, and the state of the startup plugin. Codex contributes
two skill rows; the shared `~/.agents` one is marked `(shared)`. Providers with
no startup plugin show `plugin  n/a  no startup plugin for this provider`.

State labels:

| Label | Meaning |
| --- | --- |
| `✓ current` | Installed and matches what Fleet ships. |
| `~ outdated-owned` | Fleet-owned, but stale. |
| `! conflict/unmanaged` | Present but user-managed or modified. |
| `✗ missing` | Expected but not present. |
| `- absent` | Not applicable / not present. |

### `fleet ship plugin install`

```bash
fleet ship plugin install <provider> [--force]
```

| Argument | Meaning |
| --- | --- |
| `<provider>` | One of `claude-code`, `opencode`, `copilot`, `codex`, or `all`. |

| Option | Default | Meaning |
| --- | --- | --- |
| `--force` | off | Replace conflicting regular files and claim them for Fleet. |

Installs both the `fleet-agent` skill and the startup plugin. An unrecognized
provider prints
`unknown provider "<provider>"; expected one of: claude-code, opencode, copilot, codex, all`
and exits 1. Each conflict is reported on stderr and sets the exit code to 1;
the files are preserved. When a single (non-`all`) provider has no config
directory on the machine, the command prints
`<provider>: not installed on this machine (config directory missing); nothing to do.`

## `fleet bridge`

```bash
fleet bridge [options]
```

Starts the Fleet Bridge HTTP + WebSocket API (see
[bridge API](/reference/bridge-api/)). On boot it creates the data directory,
loads the persisted ship roster, connects to every ship, and serves the API.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `-p, --port` | `<port>` | `4800` | Port the HTTP + WebSocket API listens on. Must parse as an integer. |
| `-n, --name` | `<name>` | `bridge` | Human-facing name of this bridge. Any non-empty string. |
| `-d, --data-directory` | `<dir>` | `./.fleet-bridge` | Directory the bridge persists `ships.json` and `repos.json` to. Resolved to an absolute path. |

If two reachable ships hold the same `<repo>/<name>` at startup, the bridge
prints the conflicting keys and exits 1. Any other startup failure prints
`fleet-bridge: <message>` and exits 1. On success it prints
`fleet-bridge "<name>" listening on http://localhost:<port>`.

## `fleet launch`

```bash
fleet launch [--config-path <path>]
```

Brings a bridge, ships, and the GUI up in one process from a
`fleet-config.yaml`, registering each ship with the bridge as it starts. See
[fleet-config](/reference/fleet-config/) for the full schema.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--config-path` | `<path>` | `./fleet-config.yaml` | Path to the fleet config YAML. |

Ships with `source: local` are started in-process; ships with `source: remote`
are only registered by URL. When the config has no `bridge` section, each ship
logs
`no bridge configured; not registering ship "<key>" (<url>)`. A registration
that fails logs a warning
(`could not register ship "<key>" (<url>): <message>`) and the launch continues.
Any configuration or startup error prints `fleet launch: <message>` and exits 1.

### `fleet launch init`

```bash
fleet launch init [--config-path <path>] [--force]
```

Writes the standard commented scaffold.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--config-path` | `<path>` | `./fleet-config.yaml` | Path to write the config YAML to. |
| `--force` | — | off | Overwrite an existing file. |

Without `--force`, an existing file causes
`fleet launch init: refusing to overwrite existing <path> (pass --force to replace it)`
and exit 1. On success it prints `wrote <path>`.

The agent-facing `fagent agent` and `fagent repo` commands are not part of
`fleet`; they ship as a separate binary with its own page — see the
[fagent CLI reference](/reference/fagent/).

## Exit codes and error output

| Situation | Output | Exit |
| --- | --- | --- |
| HTTP request failed | `fleet: request failed (<status>): <message>` | 1 |
| HTTP request succeeded with an empty body | `fleet: request succeeded but returned no data` | 1 |
| Ship failed to start | `fleet-ship: <message>` | 1 |
| Bridge failed to start | `fleet-bridge: <message>` | 1 |
| Launch failed | `fleet launch: <message>` / `fleet launch init: <message>` | 1 |
| `plugin install` hit a conflict | one `Conflict: …` line per file on stderr | 1 |
