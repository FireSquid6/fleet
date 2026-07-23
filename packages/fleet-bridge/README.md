# fleet-bridge

Fleet-wide orchestrator: a single endpoint fronting many [`fleet-ship`](../fleet-ship)
hosts. It exposes a **superset of the ship workspace API** with the owning ship
abstracted away (routing is automatic) but kept visible (every workspace is annotated
with its `ship`), plus ship-management endpoints. It guarantees no two ships hold the
same `<repo>/<name>`, and it keeps its view of the fleet in sync by consuming each ship's
`/events` WebSocket. Ships are trusted (no auth) and may go offline; the roster is
persisted so the fleet survives a restart.

## Run

Configured entirely from flags (sensible defaults shown):

```bash
bun run src/index.ts \
  --port 4800 \
  --name my-bridge \
  --data-directory ./.fleet-bridge   # ships.json roster is persisted here
```

To bring up a bridge together with ships and the gui in one process, use
`fleet launch` (see the CLI's `fleet-config.yaml`).

If two reachable ships hold the same `<repo>/<name>` at startup, the bridge prints the
conflict and exits.

## API

Ship management:

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/ships` | — | `{name, url, status}[]`, status `online`/`offline` |
| POST | `/ships` | `{url}` | connects, learns the ship name, rejects duplicates (409) |
| DELETE | `/ships/:name` | — | removes a ship from the fleet |

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
