---
title: CLI reference
description: Every fleet command, argument, and option, with its default.
sidebar:
  order: 1
---

The `fleet` binary is a Commander.js CLI that mounts eight top-level command
groups:

| Command | Purpose |
| --- | --- |
| `fleet client` | Drive a ship (or the fleet, via a bridge) over HTTP. |
| `fleet ship` | Run a Fleet Ship host, and manage agent integrations. |
| `fleet bridge` | Run a Fleet Bridge. |
| `fleet launch` | Bring a whole fleet up from a `fleet-config.yaml`. |
| `fleet login` | Log in to a bridge and store the session. |
| `fleet logout` | Revoke the stored session and delete it. |
| `fleet whoami` | Show who the stored session belongs to. |
| `fleet users` | Manage the bridge's users (admin only). |

Every command that talks to a bridge needs a session; see
[`fleet login`](#fleet-login) and the
[authentication guide](/guides/authentication/).

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
| `ls` (without `--wide`), `status`, `create`, `branch`, `activate`, `deactivate`, `rm` | `ls --wide`, `ships …`, `repos …`, `armory …` |

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

Ship-roster management, always via the bridge (`--bridge-url`). `ls` is open to
any user; `add` and `rm` require an **admin** session, and a member gets
`fleet: request failed (403): this endpoint requires an admin`.

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

Requires an admin session. The bridge connects and learns the ship's name from
its first `sync` event; the name is not supplied by the caller. Prints
`registered ship <name> (<url>)`.

A ship may be registered with a credential pair. There is deliberately **no flag**
for either token — a flag would land in `ps` output and shell history — so they
come from a prompt or from the environment:

| Variable | Meaning |
| --- | --- |
| `FLEET_REGISTER_SHIP_TOKEN` | The `shipToken` to register. |
| `FLEET_REGISTER_BRIDGE_TOKEN` | The `bridgeToken` to register. |

Resolution order:

1. If either variable is set, both are taken from the environment and nothing is
   prompted for.
2. Otherwise, if stdin is a terminal, the command asks for the ship token without
   echoing it. An empty answer registers the ship with no credentials and asks
   nothing further; a non-empty one is followed by a prompt for the bridge token.
3. Otherwise (a script, with neither variable set) the ship is registered with no
   credentials.

The two tokens are sent together or not at all. Sending one without the other is
a `400` from the bridge:
`fleet: request failed (400): a ship is registered with both a shipToken and a bridgeToken, or neither`.

See [authentication](/guides/authentication/) for what each token is for and how
to generate a pair.

#### `fleet client ships rm`

```bash
fleet client ships rm <name>
```

| Argument | Meaning |
| --- | --- |
| `<name>` | Ship name as reported by `ships ls`. |

Requires an admin session. Prints `removed ship <name>`.

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

### `fleet client armory`

Read-only inspection of the [armory](/guides/the-armory/), always via the bridge
(`--bridge-url`). There is no command to add, change, or delete armory content —
it is edited in the bridge's data directory.

#### `fleet client armory ls`

```bash
fleet client armory ls [--json] [--section <section>]
```

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--json` | — | off | Print the manifest as JSON — revision, entries, and `dotfileMap`. |
| `--section` | `<section>` | none | Only files in one section: `skills`, `plugins`, or `dotfiles`. |

Without `--json`, prints a header line
`revision <first 12 hex chars> (<n> file(s))` followed by a table with columns
`SECTION  PATH  SIZE  MODE`. `PATH` keeps its section prefix, so a row can be
pasted straight into `armory cat`; `SIZE` is in bytes and `MODE` is octal
(`0644` or `0755`).

`--section` filters both the table and the JSON `entries`. An unrecognized value
prints
`fleet: unknown section "<value>"; expected one of: skills, plugins, dotfiles`
and exits 1.

With no matching files and no `--json`, prints `no armory files`.

#### `fleet client armory cat`

```bash
fleet client armory cat <path>
```

| Argument | Meaning |
| --- | --- |
| `<path>` | Armory-relative path as shown by `armory ls`, e.g. `skills/reviewer/SKILL.md`. |

Takes no options. Writes the file's contents to stdout with no trailing newline
added, so `fleet client armory cat <path> > file` reproduces it exactly.

A binary file is refused rather than printed, because a terminal (or a redirect)
would capture mangled bytes without saying so:

```
fleet: dotfiles/blob.bin is binary (12 bytes, sha256 2a44e2e6…); not writing it to stdout
```

That goes to stderr and exits 1. An unknown path is a `404` from the bridge:
`fleet: request failed (404): armory file not found: <path>`.

#### `fleet client armory ships`

```bash
fleet client armory ships [--json]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Print the raw `ShipArmoryState[]` array instead of a table. |

Table columns are `SHIP  STATUS  REVISION  SYNCED  STATE`, where `STATUS` is the
ship's connection state (`online`/`offline`), `REVISION` is the ship's applied
revision abbreviated to 12 characters, and `SYNCED` is an ISO-8601 timestamp.
A value the ship has not reported renders as `-`.

`STATE` compares the ship against the bridge's current revision:

| State | Meaning |
| --- | --- |
| `in sync` | The ship holds the bridge's current revision. |
| `behind` | The ship holds an older revision. |
| `never` | The ship has never applied a revision. |
| `error` | The ship's last sync or install failed. |
| `unknown` | The bridge could not reach the ship. |

`error` takes precedence over the revision comparison: a ship whose sync failed
is stuck on a revision it could not replace.

After the table, each ship's `lastError`, install conflicts, and install warnings
are printed under its name:

```
orca:
  conflict: /home/you/.vimrc
  warning: skipped dotfile bashrc: destination "/etc/bashrc" is outside /home/you
```

With no ships registered and no `--json`, prints `no ships`.

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
| `--bridge-url` | `<url>` | none — the first bridge to push wins | The only bridge whose armory pushes this ship accepts. Must be a URL. |

`--bridge-url` pins the ship: a `POST /armory/sync` naming any other bridge is
refused with `403` and nothing is fetched. Set it to the same URL the bridge
pushes with — its `--public-url` / `bridge.publicUrl`, or `http://localhost:<bridge port>`
when that is unset. Comparison is on scheme, host, port, and path, so a trailing
slash or a difference in case does not matter. Left unset, the ship pins whichever
bridge pushes to it first. `fleet launch` sets this for every ship it spawns. See
[the Armory](/guides/the-armory/).

A ship's two credentials have no flags — they would land in `ps` output and shell
history — so they are read from the environment:

| Variable | Direction | Meaning |
| --- | --- | --- |
| `FLEET_BRIDGE_TOKEN` | inbound | The token a caller must present to reach this ship. Unset, **every route answers anyone who can reach the port**, and the ship warns about it on startup. |
| `FLEET_SHIP_TOKEN` | outbound | The token this ship presents to the bridge when it pulls the [armory](/guides/the-armory/). Unset, that pull gets a `401` from a bridge that requires authentication; nothing else is affected. |

An empty value counts as unset for both. `fleet launch` supplies both to every
`source: local` ship it spawns, so they are only needed for a ship you start
yourself — see [authentication](/guides/authentication/).

A non-integer `--port` is rejected by Commander with `must be an integer`. Any
other startup failure prints `fleet-ship: <message>` and exits 1, which includes
a `--bridge-url` that is not a URL.

On success it prints
`fleet-ship "<name>" listening on http://localhost:<port>`, followed by a warning
when no `FLEET_BRIDGE_TOKEN` is set:

```
fleet-ship "<name>" is serving without authentication: every route answers anyone who can reach the port. Set FLEET_BRIDGE_TOKEN to the token the bridge presents to require it.
```

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
| `-d, --data-directory` | `<dir>` | `./.fleet-bridge` | Directory the bridge persists `ships.json`, `repos.json`, `ephemeral.json` and `auth.db` to, and holds the `armory/` it distributes. Resolved to an absolute path. |
| `--public-url` | `<url>` | `http://localhost:<port>` | URL ships should use to reach this bridge. Handed to each ship so it can pull the [armory](/guides/the-armory/), so it must resolve from the ships' hosts. |
| `--insecure-no-auth` | — | off | Development only: serve every route without authentication, and skip creating the first admin. Also settable with `FLEET_INSECURE_NO_AUTH=1`. |

Before it serves anything, a bridge whose `auth.db` holds no users creates the
first admin: from `FLEET_BRIDGE_ADMIN_USER`, `FLEET_BRIDGE_ADMIN_EMAIL` and
`FLEET_BRIDGE_ADMIN_PASSWORD` if all three are set, otherwise by prompting on
stdin. Setting only some of the three is an error, and so is having none of them
set with stdin not a terminal:

```
fleet-bridge: fleet-bridge has no users and stdin is not a terminal — set FLEET_BRIDGE_ADMIN_USER, FLEET_BRIDGE_ADMIN_EMAIL, FLEET_BRIDGE_ADMIN_PASSWORD to create the first admin, or start with --insecure-no-auth
```

With `--insecure-no-auth` the bridge writes a banner to stderr for as long as it
runs, and every request is treated as an admin user. See
[authentication](/guides/authentication/).

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

There is no flag for a ship's credentials or for disabling authentication; both
live in the config file (`shipToken`/`bridgeToken` and `bridge.insecureNoAuth`).
A launched bridge bootstraps its first admin exactly like `fleet bridge` does,
which is why a headless launch needs either the `FLEET_BRIDGE_ADMIN_*` variables
or `bridge.insecureNoAuth`. `FLEET_INSECURE_NO_AUTH` is not read on this path.

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

## `fleet login`

```bash
fleet login [--bridge-url <url>] [-u <username>]
```

Logs in to a bridge and stores the session.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--bridge-url` | `<url>` | `http://localhost:4800` | Bridge to log in to. Normalized like every other URL option. |
| `-u, --username` | `<username>` | prompted for | Username to log in as. |

The password is always prompted for, never an option. Both prompts need a
terminal; with stdin redirected the command refuses rather than blocking:

```
fleet: credentials for http://localhost:4800 have to be typed at a terminal, and stdin is not one — set FLEET_TOKEN instead
```

On success it prints `logged in to <url> as <username>` and writes the token to
`$XDG_STATE_HOME/fleet-client-cli/<slug of the bridge url>/session.json` — file
mode `0600`, directory `0700`, one file per bridge. `XDG_STATE_HOME` defaults to
`~/.local/state`.

Any bridge-facing command reuses that session automatically. When there is none
and the bridge reports `authRequired: true`, an interactive run logs you in on
the spot; a non-interactive one fails:

```
fleet: not logged in to <url> and stdin is not a terminal — run `fleet login --bridge-url <url>` first, or set FLEET_TOKEN
```

`FLEET_TOKEN` overrides the stored session entirely, which is how scripts and CI
authenticate. A stored token that has expired or been revoked produces a `401`;
the CLI then discards it and retries the call exactly once with fresh
credentials.

Sessions expire 30 days after they are issued and are never extended.

## `fleet logout`

```bash
fleet logout [--bridge-url <url>]
```

Revokes the stored session on the bridge and deletes the local file. Prints
`logged out of <url>`. If the bridge cannot be reached, the local file is deleted
anyway and a warning goes to stderr:

```
fleet: could not revoke the session on <url> (<message>); clearing it locally anyway
```

Running it with no stored session is a no-op.

## `fleet whoami`

```bash
fleet whoami [--bridge-url <url>]
```

Prints `<username> (<role>) on <url>`, or `not logged in to <url>` when there is
no stored session or the bridge has rejected it. Unlike other bridge commands it
never prompts for a login.

## `fleet users`

```bash
fleet users <subcommand> [--bridge-url <url>]
```

Manages the bridge's users. Every subcommand requires an **admin** session; a
member gets `fleet: request failed (403): this endpoint requires an admin`,
except for `passwd` on your own account, which any user may do.

`--bridge-url` belongs to `fleet users` itself, so it goes before the
subcommand: `fleet users --bridge-url 4801 ls`.

### `fleet users ls`

| Option | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Print the raw JSON array instead of a table. |

With no rows and no `--json`, prints `no users`.

### `fleet users add`

```bash
fleet users add <username> <email> [--role <role>]
```

| Argument | Meaning |
| --- | --- |
| `<username>` | Username. |
| `<email>` | Email address. |

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--role` | `<role>` | `member` | `admin` or `member`. |

The password is prompted for twice and never taken as an argument. A mismatch
prints `passwords did not match, try again` and asks again. With stdin not a
terminal the command refuses:
`fleet: a password has to be typed at a terminal, and stdin is not one`.

An unrecognized role prints
`fleet: unknown role "<role>"; expected admin or member` and exits 1. On success
it prints `created user <username> (<role>)`.

### `fleet users rm`

```bash
fleet users rm <username>
```

Prints `removed user <username>`. Deleting the last admin is refused by the
bridge with a `409`.

### `fleet users passwd`

```bash
fleet users passwd <username>
```

Prompts for the new password twice, exactly like `users add`. Setting a password
revokes every session that user holds. Prints
`changed the password for <username>`.

### `fleet users role`

```bash
fleet users role <username> <role>
```

| Argument | Meaning |
| --- | --- |
| `<username>` | Username. |
| `<role>` | `admin` or `member`. |

Prints `<username> is now <role>`. Demoting the last admin is refused by the
bridge with a `409`. Changing a role does not revoke that user's sessions; the
new role takes effect on their next request.

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
