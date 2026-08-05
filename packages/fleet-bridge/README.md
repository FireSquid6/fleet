# fleet-bridge

Fleet-wide orchestrator: a single endpoint fronting many [`fleet-ship`](../fleet-ship)
hosts. It exposes a **superset of the ship workspace API** with the owning ship
abstracted away (routing is automatic) but kept visible (every workspace is annotated
with its `ship`), plus ship-management endpoints. It guarantees no two ships hold the
same `<repo>/<name>`, and it keeps its view of the fleet in sync by consuming each ship's
`/events` WebSocket. Ships may go offline; the roster is persisted so the fleet survives
a restart.

Every route is authenticated by default. See [Authentication](#authentication) below,
and the [authentication guide](../../apps/docs/src/content/docs/guides/authentication.md)
for the whole picture.

## Run

Configured entirely from flags (sensible defaults shown):

```bash
bun run src/index.ts \
  --port 4800 \
  --name my-bridge \
  --data-directory ./.fleet-bridge   # ships.json, repos.json and auth.db live here
```

On a fresh data directory the bridge has no users, so before it serves anything it
creates the first admin: from `FLEET_BRIDGE_ADMIN_USER`, `FLEET_BRIDGE_ADMIN_EMAIL` and
`FLEET_BRIDGE_ADMIN_PASSWORD` if all three are set, otherwise by prompting on stdin.
With stdin not a terminal and the variables unset it refuses to start. Add
`--insecure-no-auth` (or `FLEET_INSECURE_NO_AUTH=1`) to skip both and serve every route
open — development only; it prints a banner saying so.

To bring up a bridge together with ships and the gui in one process, use
`fleet launch` (see the CLI's `fleet-config.yaml`).

If two reachable ships hold the same `<repo>/<name>` at startup, the bridge prints the
conflict and exits.

## Authentication

Credentials are bearer tokens in an `Authorization: Bearer <token>` header. Three kinds
of principal exist, and each is confined to what it needs:

| Principal | Obtained by | May reach |
|---|---|---|
| user | `POST /auth/login` with a username and password | every route; `admin`-only routes additionally require `role: "admin"` |
| ship | `POST /ships` with a `shipToken` | `GET /armory` and `GET /armory/file`, nothing else |
| ship-agent | minted by the bridge and pushed to the ship, refreshed on every reconnect | `/repos` and `/repos/*`, any method |

`POST /auth/login`, `GET /auth/mode` and `POST /auth/logout` are the only routes that
answer without a credential. Anything else without one is a `401`; a credential of the
wrong kind is a `403`. The check runs before route matching, so unknown paths are gated
too.

Sessions live 30 days from issue and are never extended. `POST /auth/logout` revokes one;
changing a password revokes every session that user holds.

WebSocket routes cannot carry a header from a browser, so a client calls
`POST /auth/ws-ticket` and appends `?ticket=<t>` to the socket URL. Tickets are held in
memory, last 30 seconds, are single-use, and are only honoured on a request that is
actually a WebSocket upgrade.

Stored in `<data-directory>/auth.db` (mode `0600`): password hashes, the sha256 of each
session token, the sha256 of each `shipToken` and `agentToken`, and each `bridgeToken` in
cleartext — the bridge has to present that one to its ship on every call, so it cannot be
a one-way hash.

> **Bearer tokens are readable by anyone who can see the traffic.** Run the bridge behind
> TLS, or on a network you trust.

## API

Ship management:

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/ships` | — | `{name, url, status}[]`, status `online`/`offline` |
| POST | `/ships` | `{url, shipToken?, bridgeToken?}` | connects, learns the ship name, rejects duplicates (409); the two tokens are supplied together or not at all (400) |
| DELETE | `/ships/:name` | — | removes a ship from the fleet, and its stored credentials |

Auth:

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/auth/mode` | — | `{authRequired}` — public, so a client can tell whether to ask for a password |
| POST | `/auth/login` | `{username, password}` | `{token, user}`; `401` on a bad pair |
| POST | `/auth/logout` | — | revokes the presented bearer token; public, and a no-op without one |
| GET | `/auth/me` | — | the logged-in user |
| POST | `/auth/ws-ticket` | — | `{ticket, expiresAt}` for a WebSocket URL |
| GET/POST | `/users`, `/users/:name/role`, `DELETE /users/:name` | | admin only |
| POST | `/users/:name/password`, `/users/:name/email` | | the user themselves, or an admin |

Workspaces (superset of the ship API; every response carries `ship`):

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/workspaces?active=true\|false` | — | merged across all ships, deduped |
| GET | `/workspaces/:repo/:name` | — | proxied live to the owning ship (fresh diff) |
| POST | `/workspaces` | `{repo, name, branch, ship}` | `ship` names the target host |
| POST | `/workspaces/:repo/:name/branch` | `{branch}` | |
| POST | `/workspaces/:repo/:name/activate` | — | |
| POST | `/workspaces/:repo/:name/deactivate` | — | |
| DELETE | `/workspaces/:repo/:name` | — | |
| WS | `/workspaces/:repo/:name/terminal` | — | proxied to the owning ship's terminal |

Mutations to an offline ship's workspaces return `503`; unknown workspaces return `404`.

## Test

```bash
bun test ../../tests/fleet-bridge
```
