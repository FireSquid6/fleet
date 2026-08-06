---
title: Authentication
description: Who may do what in a fleet, where every secret lives, how to bootstrap the first admin, and how to register a ship that carries credentials.
sidebar:
  order: 10
---

Every route on the bridge is authenticated by default. This page covers the whole
surface: the principals and their limits, where each secret is stored, how the first
admin is created, how to register a ship with credentials, and what
`--insecure-no-auth` gives up.

:::danger
Fleet authenticates with **bearer tokens**, which travel in a plain
`Authorization: Bearer <token>` header. Anyone who can read the traffic can replay
them. Run the bridge and every ship behind TLS, or on a network you trust — a VPN, a
WireGuard mesh, an SSH tunnel. Fleet does not terminate TLS itself.
:::

## Principals

A credential resolves to exactly one of three principals, and each one is confined to
what it needs.

| Principal | Credential | May reach |
| --- | --- | --- |
| **user** | a session token from `POST /auth/login` | every bridge route; the admin-only ones additionally require `role: admin` |
| **ship** | its `shipToken` | `GET /armory` and `GET /armory/file` on the bridge, and nothing else |
| **ship-agent** | an agent token the bridge mints and pushes to the ship | `/repos` and everything under it, any method |

Users come in two roles:

| Role | Additional powers |
| --- | --- |
| `member` | Create, activate and delete workspaces; register and remove repos; read the ship roster and the armory. |
| `admin` | Everything a member can do, plus registering and removing ships, and `fleet users` — list, create, delete users and change their roles. |

Registering a ship is admin-only because it tells the bridge to open a connection to
a URL the caller chose, and removing one takes a host out of the fleet. Reading the
roster is not privileged: `GET /ships` and `fleet client ships ls` are open to any
user.

Changing a password or an email address is allowed for the user themselves or for an
admin; everything else under `/users` is admin-only. There is no per-workspace
ownership: any member can act on any workspace on any ship in the fleet.

Three routes answer without any credential, because a client needs them before it has
one: `POST /auth/login`, `GET /auth/mode` (which reports whether this bridge requires
auth at all) and `POST /auth/logout`. Everything else without a credential is a `401`;
a credential of the wrong kind is a `403`
(`a ship credential may not reach GET /workspaces`). The check runs before route
matching, so an unknown path is gated the same way.

### Sessions

A session token is 32 random bytes, base64url. It lives **30 days from issue and is
never extended** — an active session still expires on day 30. `fleet logout` and the
GUI's sign-out revoke one; changing a user's password revokes every session that user
holds; deleting a user revokes theirs.

### WebSockets

A browser cannot put a header on a WebSocket handshake, so the client asks for a
short-lived ticket (`POST /auth/ws-ticket`) and appends `?ticket=<t>` to the socket URL.
Tickets last 30 seconds, are single-use, are held only in the bridge's memory (a restart
invalidates all of them), and are only accepted on a request that really is a WebSocket
upgrade — so a stray link containing one cannot burn it.

## Where every secret lives

| Secret | Where | Form | Mode |
| --- | --- | --- | --- |
| user passwords | `<bridge data directory>/auth.db` | hashed (`Bun.password`) | `0600` |
| session tokens | `auth.db` | sha256 of the token | `0600` |
| a ship's `shipToken` | `auth.db` | sha256 of the token | `0600` |
| a ship's `bridgeToken` | `auth.db` | **cleartext** | `0600` |
| agent tokens | `auth.db` | sha256 of the token | `0600` |
| the CLI's session | `$XDG_STATE_HOME/fleet-client-cli/<bridge>/session.json` (`~/.local/state/…` by default) | cleartext token | file `0600`, directory `0700` |
| the GUI's session | browser `localStorage`, key `fleet.bridge.token` | cleartext token | — |
| a ship's agent token | `<fleet directory>/atlas.json` | cleartext | `0600` |

The `bridgeToken` is the one secret the bridge keeps in cleartext, and deliberately: the
bridge has to *present* it to the ship on every call, so it cannot be a one-way hash.
Everything the bridge only ever *verifies* is stored as a hash.

`auth.db` is chmod'd to `0600` by the bridge, but the directory containing it is created
with your umask. If the data directory is somewhere other processes can read, tighten it
yourself. SQLite's `-wal` and `-shm` sidecar files are not chmod'd.

The ship's `atlas.json` publishes the ship's port and this run's agent token so agents
inside a workspace can call back; that agent token is regenerated on every ship start and
never persists across one.

## Bootstrapping the first admin

A bridge with no users creates one before it serves anything. There are three paths, and
which one you get depends on the environment.

### Non-interactively, from environment variables

Set all three:

```bash
export FLEET_BRIDGE_ADMIN_USER=ada
export FLEET_BRIDGE_ADMIN_EMAIL=ada@example.com
export FLEET_BRIDGE_ADMIN_PASSWORD='…'
fleet bridge --data-directory /srv/fleet/bridge
```

Setting only some of them is an error rather than a fallback to prompting, because a
half-configured deployment silently prompting on a machine with no terminal is worse:

```
fleet-bridge admin bootstrap is only half configured: set FLEET_BRIDGE_ADMIN_EMAIL, FLEET_BRIDGE_ADMIN_PASSWORD as well (FLEET_BRIDGE_ADMIN_USER already set), or unset all three to be asked interactively
```

These variables are read once, on a bridge that has no users. On every later start they
are ignored.

### Interactively

With none of them set and stdin a terminal, the bridge asks:

```
fleet-bridge has no users yet. Create the first admin.
username: ada
email: ada@example.com
password:
confirm password:
created admin "ada"
```

### Headless, with nothing set

Under systemd, in a container, or anywhere stdin is not a terminal, prompting would hang
forever with no output, so the bridge refuses to start:

```
fleet-bridge: fleet-bridge has no users and stdin is not a terminal — set FLEET_BRIDGE_ADMIN_USER, FLEET_BRIDGE_ADMIN_EMAIL, FLEET_BRIDGE_ADMIN_PASSWORD to create the first admin, or start with --insecure-no-auth
```

That is the failure to expect on a first deploy. Fix it with the three variables, or —
for a development fleet only — with `--insecure-no-auth`.

Once the first admin exists, further users come from `fleet users add`, which prompts for
the password and refuses to take it as an argument.

## Logging in

From the CLI:

```bash
fleet login --bridge-url http://bridge.internal:4800
fleet whoami --bridge-url http://bridge.internal:4800
fleet logout --bridge-url http://bridge.internal:4800
```

`fleet login` prompts for a username (unless `-u` is given) and always prompts for the
password. The session is written to `~/.local/state/fleet-client-cli/<bridge>/session.json`
with mode `0600`, one file per bridge URL.

Any `fleet client` command that talks to a bridge reuses that session. If there is none
and stdin is a terminal, it logs you in on the spot; if stdin is not a terminal it fails
rather than blocking:

```
fleet: not logged in to http://bridge.internal:4800 and stdin is not a terminal — run `fleet login --bridge-url http://bridge.internal:4800` first, or set FLEET_TOKEN
```

For CI and scripts, set `FLEET_TOKEN` to a session token; it overrides the stored session
entirely. A stored token that has expired or been revoked produces a `401`, which the CLI
answers by discarding it and retrying exactly once with fresh credentials.

From the web GUI: the app shows a sign-in gate when the bridge reports
`authRequired: true`, and stores the session token in `localStorage`. A `401` from any
request drops you back to that gate.

## Ship credentials

A ship and its bridge authenticate each other with a pair of tokens, and the two
directions are separate:

| Token | Presented by | To | Purpose |
| --- | --- | --- | --- |
| `bridgeToken` | the bridge | the ship | lets the ship reject calls that are not from its bridge |
| `shipToken` | the ship | the bridge | lets the ship pull the armory from the bridge |

They are registered together. `POST /ships` with one and not the other is a `400`:
`a ship is registered with both a shipToken and a bridgeToken, or neither`.

A ship started with **no** `bridgeToken` serves every route to anyone who can reach its
port, including its terminal WebSocket, and says so at startup:

```
fleet-ship "gpu-box" is serving without authentication: every route answers anyone who can reach the port. Set FLEET_BRIDGE_TOKEN to the token the bridge presents to require it.
```

### Registering a ship with credentials

Registration is admin-only whether or not credentials are involved, except through
`fleet launch`, which registers ships inside the bridge process it starts and so
never presents a session at all.

Whichever route you take, generate a pair first. Any 32 bytes of CSPRNG output in
base64url will do — that is the shape the bridge mints:

```bash
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))'
```

**From the web GUI.** Ships → New Ship has optional *Ship token* and *Bridge token*
fields with a **Generate** control that fills both, and a **Copy** button per field. Copy
them before you submit: the bridge stores only a hash of the ship token, so nothing can
show it to you again. Leaving both blank registers a ship with no credentials, exactly as
before.

**From the CLI.** `fleet client ships add` never takes a token as a flag — flags leak
through `ps` and shell history. At a terminal it prompts, without echoing:

```
$ fleet client ships add http://gpu-box.internal:4700
ship token (blank to register without credentials):
bridge token:
registered ship gpu-box (http://gpu-box.internal:4700)
```

Pressing enter at the first prompt registers the ship with no credentials. In a script,
set `FLEET_REGISTER_SHIP_TOKEN` and `FLEET_REGISTER_BRIDGE_TOKEN` instead; either being
set suppresses the prompts entirely, and with neither set on a non-terminal stdin the
ship is registered without credentials rather than hanging on a prompt nobody can answer.

**From `fleet launch`.** `shipToken` and `bridgeToken` are optional keys on any ship in
`fleet-config.yaml`, and `${VAR}` reads them from the environment so the secret never has
to live in the file:

```yaml
bridge:
  port: 4800
  publicUrl: http://10.0.0.2:4800
ships:
  gpu-box:
    source: remote
    url: http://10.0.0.7:4700
    shipToken: ${GPU_BOX_SHIP_TOKEN}
    bridgeToken: ${GPU_BOX_BRIDGE_TOKEN}
```

A referenced variable that is unset or empty fails the launch — better than quietly
registering a ship with no credentials at all. See the
[fleet-config reference](/reference/fleet-config/) for the exact rules.

Ships with `source: local` that set neither key keep the behaviour they have always had:
`fleet launch` mints a fresh pair for each one, hands it to the ship it spawns, and
registers it with the bridge. Set both keys on a local ship to pin the pair instead.

### Starting the remote ship

The ship end of the pair is two environment variables — one per direction, holding the
same two values you registered:

```bash
FLEET_BRIDGE_TOKEN='…the bridge token…' \
FLEET_SHIP_TOKEN='…the ship token…' \
  fleet ship --port 4700 --name gpu-box --bridge-url http://10.0.0.2:4800
```

Neither has a flag, for the same reason no other secret on this branch does: a flag lands
in `ps` output and shell history.

`FLEET_BRIDGE_TOKEN` is the inbound half. With it set, the ship answers only two callers:
its bridge, presenting that token, and an agent inside one of its own workspaces,
presenting the per-run agent token from `atlas.json`. The bridge may reach every route;
the agent is confined to `GET /agent/credentials` and a workspace's own `agent/init` and
`agent/status`.

`FLEET_SHIP_TOKEN` is the outbound half. The ship presents it when it pulls the
[armory](/guides/the-armory/) from the bridge — `GET /armory` and `GET /armory/file`,
the only two routes a ship principal may reach. Omit it against a bridge that requires
authentication and the pull fails:

```
bridge answered 401 for the armory manifest
```

That surfaces as `lastError` in `fleet client armory ships`, and only the armory is
affected — workspaces on the ship keep working, which is exactly what makes it easy to
miss.

:::note
A `source: local` ship under `fleet launch` needs neither variable. The launch generates
the pair, hands it to the ship it spawns in-process, and registers it with the bridge in
one step. These two variables are for ships you start yourself.
:::

## `--insecure-no-auth`

```bash
fleet bridge --insecure-no-auth
```

or, equivalently, `FLEET_INSECURE_NO_AUTH=1`, or in `fleet-config.yaml`:

```yaml
bridge:
  insecureNoAuth: true
```

It does two things: it skips creating the first admin, and it makes **every request an
admin user** before any header is read. That means:

- Every route answers every client that can reach the port, on every address the bridge
  is listening on.
- Authorization is gone too, not just authentication — there is no member/admin
  distinction left, and `fleet users` is open to anyone.
- Ship and ship-agent tokens are not even parsed, so a ship token that would normally
  reach only the armory has full admin.
- `GET /auth/mode` reports `authRequired: false`, which is how the GUI and CLI know not
  to ask for a password.

It does not disable the ship's own guard: a ship with `FLEET_BRIDGE_TOKEN` set still
requires it. There is no `--insecure-no-auth` for a ship — a ship is open exactly when it
has no `bridgeToken`.

The bridge prints a banner on stderr for as long as it runs:

```
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!  AUTHENTICATION IS DISABLED  (--insecure-no-auth)
!!
!!  Every route on this bridge answers any client that can reach
!!  it, on every address it is listening on. Anyone on your network
!!  can read and control this fleet.
!!
!!  Local development only.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
```

One asymmetry worth knowing: `FLEET_INSECURE_NO_AUTH=1` is read by `fleet bridge` only.
`fleet launch` does not consult it, so under `fleet launch` the setting has to be
`bridge.insecureNoAuth` in the YAML.

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `FLEET_BRIDGE_ADMIN_USER` | bridge | With the other two, creates the first admin non-interactively. All three or none. |
| `FLEET_BRIDGE_ADMIN_EMAIL` | bridge | " |
| `FLEET_BRIDGE_ADMIN_PASSWORD` | bridge | " |
| `FLEET_INSECURE_NO_AUTH` | `fleet bridge` | `=1` disables authentication. Not read by `fleet launch`. |
| `FLEET_TOKEN` | `fleet` CLI | A session token for bridge calls; overrides the stored session file. |
| `FLEET_BRIDGE_TOKEN` | `fleet ship` | The token inbound callers must present to this ship. Unset, every ship route is open. |
| `FLEET_SHIP_TOKEN` | `fleet ship` | The token this ship presents to the bridge when it pulls the armory. |
| `FLEET_BRIDGE_TOKEN` | `fleet client` | The same name in the other direction: the token the CLI presents when it calls a ship directly (`--url`, `attach`). |
| `FLEET_REGISTER_SHIP_TOKEN` | `fleet client ships add` | The `shipToken` to register, instead of prompting. |
| `FLEET_REGISTER_BRIDGE_TOKEN` | `fleet client ships add` | The `bridgeToken` to register, instead of prompting. |

## Checklist for a real deployment

1. Put the bridge behind TLS, or on a trusted network. Bearer tokens are sniffable.
2. Create the first admin from `FLEET_BRIDGE_ADMIN_*`, not from a prompt, so the deploy
   is reproducible.
3. Give the bridge a data directory only its user can read; `auth.db` is `0600` but its
   parent directory is whatever your umask makes it.
4. Start every ship you run yourself with both `FLEET_BRIDGE_TOKEN` and
   `FLEET_SHIP_TOKEN` set, and register it with that same pair. A ship without the
   first is open to its whole network; a ship without the second cannot pull the
   armory.
5. Never pass a token as a command-line flag, and keep it out of the YAML with `${VAR}`.
6. Do not run `--insecure-no-auth` anywhere but a development machine.
