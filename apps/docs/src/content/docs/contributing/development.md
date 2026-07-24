---
title: Development
description: Set up the monorepo, run the services, and follow the repo's conventions.
sidebar:
  order: 1
---

Fleet is a single Bun monorepo. There is no build step for day-to-day work: every
workspace ships TypeScript source, and Bun runs it directly.

## Repo layout

Workspaces are declared in the root `package.json` as `packages/*` and `apps/*`.
`packages/*` holds libraries and long-running services; `apps/*` holds the things
you invoke directly.

| Workspace | What it is |
| --- | --- |
| `packages/bun-vt` | Pure-TypeScript port of libghostty's VT emulation — escape-sequence parser plus screen/grid model. No native code, no FFI. |
| `packages/webterm` | The JSON-over-WebSocket terminal protocol, plus the server-side bridge that turns a PTY into streamed grid snapshots. `webterm/protocol` is the browser-safe, type-only entry point. |
| `packages/git-bun` | Typed, object-oriented wrapper around the git CLI. Each instance is bound to one working directory and confined to it. |
| `packages/tmux-bun` | Typed wrapper around the tmux CLI. Drives tmux headlessly, with each instance confined to its own isolated tmux server. |
| `packages/fleet-protocol` | The shared contract between ship, bridge, client, and CLI: zod schemas, types, and constants. No runtime dependencies beyond zod. |
| `packages/fleet-ship` | The ship host — an HTTP + WebSocket API that owns workspaces on one machine. Exposes a `fleet-ship` bin and the `ship` subcommand. |
| `packages/fleet-bridge` | The fleet-wide orchestrator: one endpoint fronting many ships, with a superset of the ship workspace API plus ship/repo management. |
| `packages/fleet-client` | The web GUI: a React app plus the Bun server that serves it and proxies to a bridge. |
| `apps/cli` | The unified `fleet` CLI. Composes the `ship` and `bridge` commands from their packages and adds `client`, `launch`, and `agent`. |
| `apps/docs` | This documentation site (Astro + Starlight). |

For what each library actually exposes, see [Packages](/packages/overview/).

Dependencies between workspaces are declared with `workspace:*`, for example in
`packages/fleet-bridge/package.json`:

```json
{
  "dependencies": {
    "fleet-protocol": "workspace:*",
    "fleet-ship": "workspace:*",
    "git-bun": "workspace:*",
    "webterm": "workspace:*"
  }
}
```

`bun install` symlinks those into each workspace's `node_modules`, so an import
like `import { ship } from "fleet-ship"` resolves straight to
`packages/fleet-ship/src/index.ts` on disk. Editing a package is immediately
visible to every consumer — nothing to rebuild, nothing to relink.

## Getting set up

Prerequisites:

- **Bun.** The repo is developed against Bun 1.3.x (1.3.14 at the time of
  writing). Bun is the runtime, package manager, test runner, and bundler here;
  Node is not used.
- **git**, on `PATH`. `git-bun` shells out to it, and several test suites create
  real repositories.
- **tmux**, on `PATH`. `tmux-bun` and the ship's workspace sessions shell out to
  it, and `packages/tmux-bun` and `packages/fleet-ship` tests spawn real tmux
  servers.

Install once from the repo root:

```bash
bun install
```

That resolves every workspace at once. Do not run `bun install` inside an
individual package — the lockfile (`bun.lock`) is at the root and covers the
whole monorepo.

:::note
The `fleet` bin is declared in `apps/cli/package.json` but is not linked into the
root `node_modules/.bin`. From a clone, invoke the CLI by path:

```bash
bun run apps/cli/src/index.ts --help
```

The rest of this page uses that form. If you have installed a released binary,
substitute `fleet` — see [Installation](/start/installation/).
:::

## Running things locally

### A whole dev fleet

`fleet launch` brings up a bridge, any number of ships, and the GUI in a single
process from one `fleet-config.yaml`. Scaffold a commented config, then start it:

```bash
bun run apps/cli/src/index.ts launch init
bun run apps/cli/src/index.ts launch
```

A minimal local config — bridge on 4800, one ship on 4700, GUI on 3000:

```yaml
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: my-fleet-bridge

gui:
  port: 3000

ships:
  ship-a:
    source: local
    fleetDirectory: ./fleet/ship-a
    port: 4700
```

Every section is optional; only the sections present are started. Each local ship
must have a distinct port, and a `gui` section needs either a `bridge` section or
an explicit `gui.bridgeUrl` to proxy to. Pass `--config-path` to use a file other
than `./fleet-config.yaml`. The full schema is documented in
[Configuring a fleet](/guides/configuring-a-fleet/).

Both `dataDirectory` and `fleetDirectory` are workspace state on disk. Keep them
under a gitignored path (`fleet-data`, `dev-data`, `.dev-data`, and `build` are
already ignored) or outside the repo.

### Individual services

Each service is also a standalone subcommand, which is usually what you want when
you are iterating on one of them:

```bash
# Ship: hosts workspaces under <fleet-directory>/<repo>/<name>
bun run apps/cli/src/index.ts ship --port 4700 --name ship-a --fleet-directory ./fleet/ship-a

# Bridge: fronts one or more ships, persists its roster to the data directory
bun run apps/cli/src/index.ts bridge --port 4800 --name my-bridge --data-directory ./.fleet-bridge

# GUI: serves the web client and proxies to a bridge
bun run apps/cli/src/index.ts client serve --url http://localhost:4800
```

Ships are registered with a running bridge by URL:

```bash
bun run apps/cli/src/index.ts client ships add http://localhost:4700
```

`packages/fleet-ship` and `packages/fleet-bridge` each also have a `start` script
(`bun run src/index.ts`) if you prefer to run them from inside the package.

For hot reload on the GUI, `packages/fleet-client` has a dev entry point:

```bash
cd packages/fleet-client
bun run dev
```

That runs `bun --hot dev.ts`, which points at a bridge on `http://localhost:4800`
— start a bridge first.

### The docs site

```bash
cd apps/docs
bun run dev        # dev server on localhost:4321
bun run build      # production build into ./dist
bun run preview    # serve the built site
bun run typecheck  # astro check
```

## Tests and typechecking

Two scripts at the repo root fan out over every workspace:

```json
{
  "scripts": {
    "test": "bun run --filter='*' test",
    "typecheck": "bun run --filter='*' typecheck"
  }
}
```

`--filter='*'` runs the named script in each workspace that defines it and skips
the ones that do not, so the root commands are:

```bash
bun run test
bun run typecheck
```

Coverage is not uniform. What each workspace actually defines:

| Workspace | `test` | `typecheck` |
| --- | --- | --- |
| `bun-vt` | `bun test` (suites in `test/`) | `tsc --noEmit` |
| `git-bun` | `bun test` (`index.test.ts`, colocated) | `tsc --noEmit` |
| `tmux-bun` | `bun test` (`index.test.ts`, colocated) | `tsc --noEmit` |
| `webterm` | `bun test tests` | `tsc --noEmit` |
| `fleet-protocol` | `bun test tests` | `tsc --noEmit` |
| `fleet-ship` | `bun test tests` | `tsc --noEmit` |
| `fleet-bridge` | `bun test tests` | `tsc --noEmit` |
| `fleet-client` | `bun test tests` | — none |
| `apps/cli` | `bun test tests` | `tsc --noEmit` |
| `apps/docs` | — none | `astro check` |

`fleet-client` has no `typecheck` script, so the root typecheck does not cover it.
`apps/docs` has no tests; it is checked by `astro check` instead.

To run one package's suite, either filter from the root or run `bun test` inside
the package:

```bash
bun run --filter='fleet-ship' test

cd packages/fleet-ship && bun test tests
```

A single file or a name pattern, from anywhere:

```bash
bun test packages/fleet-bridge/tests/terminal-proxy.test.ts
bun test packages/fleet-ship/tests --test-name-pattern "workspace"
```

:::caution
`packages/fleet-bridge/README.md` still tells you to run
`bun test ../../tests/fleet-bridge`. That path does not exist — there is no
top-level `tests/` directory in the repo. The bridge's suites live in
`packages/fleet-bridge/tests/`, matching its own `test` script. Every package's
tests are inside that package.
:::

The ship, bridge, git, and tmux suites exercise the real binaries: they create
throwaway git repositories and spawn isolated tmux servers. They are not mocked,
so a missing `git` or `tmux` shows up as a test failure rather than a clear
setup error.

There is no linter or formatter configured in this repo — no ESLint, Prettier, or
Biome config, and no `lint` script. Type checking and tests are the whole gate.

### CI

The only workflow is `.github/workflows/release.yml`, and it runs on `v*` tags —
not on pushes or pull requests. It installs with `bun install --frozen-lockfile`,
runs `bun scripts/build-all-versions.ts`, and attaches the cross-platform
binaries under `build/` to a GitHub release.

:::caution
`scripts/build-all-versions.ts` is referenced by the workflow but is not checked
into the repo, so the release job cannot currently succeed as written. Nothing
runs tests or typechecking in CI either — run `bun run test` and
`bun run typecheck` locally before opening a pull request.
:::

## Conventions

These are the rules the repo actually enforces in review. The root `CLAUDE.md`
covers comments and the database; each workspace's `CLAUDE.md` covers Bun usage.

### Bun, not Node

Reach for the Bun equivalent before adding a dependency:

| Instead of | Use |
| --- | --- |
| `node file.ts`, `ts-node` | `bun file.ts` |
| `npm install`, `yarn`, `pnpm` | `bun install` |
| `npm run <script>` | `bun run <script>` |
| `npx <pkg>` | `bunx <pkg>` |
| `jest`, `vitest` | `bun test` |
| `webpack`, `esbuild`, `vite` | `bun build` and HTML imports |
| `express` | `Bun.serve()` (routes, WebSockets, HTTPS) |
| `ws` | the built-in `WebSocket` |
| `better-sqlite3` | `bun:sqlite` |
| `pg`, `postgres.js` | `Bun.sql` |
| `ioredis` | `Bun.redis` |
| `dotenv` | nothing — Bun loads `.env` automatically |
| `node:fs` `readFile`/`writeFile` | `Bun.file` / `Bun.write` |
| `execa` | ``Bun.$`ls` `` |

`node:` builtins are still fair game where Bun has no better answer — the
launch config resolves paths with `node:path`, for instance. The rule is about
not pulling in npm packages that Bun already replaces.

### Comments explain *why*, not *what*

A comment that restates the adjacent code is noise: it duplicates the code and
rots the moment the code changes. If a comment only tells you what you would
learn from reading the next line, delete it and make the code clearer instead.

Comments that carry information the code cannot are expected and welcome:

- Rationale, trade-offs, invariants, ordering constraints, race conditions, and
  workarounds for external behavior.
- The underlying command or API a thin wrapper drives, when the code does not
  make it obvious.
- Non-obvious return or parameter conventions, such as a function returning `""`
  for a detached HEAD.
- File- and module-header docs describing a component's role and design — most
  entry points in this repo open with one.
- Section dividers such as `// --- lifecycle ---` in long files.

### Database access

Two hard rules:

1. API routes never touch drizzle queries directly. Every query goes behind a
   service class (`ThingService`), and routes call the service.
2. Import the schema as a namespace, never by named import:

```ts
// Yes
import * as schema from "../src/db/schema.ts";

// No
import { workspaces } from "../src/db/schema.ts";
```

## Working on the docs site

Pages are Markdown (or MDX) under `apps/docs/src/content/docs/`, and the file
path is the route: `contributing/development.md` becomes
`/contributing/development/`. The content collection is defined in
`src/content.config.ts` using Starlight's `docsLoader` and `docsSchema`.

Sidebar sections come from `astro.config.mjs`, and each maps to a directory:

| Directory | Section |
| --- | --- |
| `start/` | Start here — introduction, installation, quickstart |
| `concepts/` | How Fleet works: architecture, workspaces, ships, events |
| `guides/` | Task-oriented walkthroughs |
| `reference/` | Exhaustive CLI, HTTP API, and config surface |
| `packages/` | Per-package library docs for `packages/*` |
| `contributing/` | Repo layout, development, testing |

Every group except `start/` is `autogenerate`d from its directory, so a new file
appears in the sidebar on its own. `start/` is listed by hand in the config, so
adding a page there means editing `astro.config.mjs` too.

Frontmatter contract:

```yaml
---
title: Development
description: Set up the monorepo, run the services, and follow the repo's conventions.
sidebar:
  order: 1
---
```

`title` is required and renders as the page's `<h1>` — start your body content at
`##`. `description` feeds the meta description and the autogenerated link
previews. `sidebar.order` sets position within an autogenerated group; lower
comes first.

Link between pages with root-absolute paths and a trailing slash — for example
`/reference/cli/` or `/start/installation/` — so links survive being moved
between directories.

Then, from `apps/docs`:

```bash
bun run dev
bun run build
bun run typecheck
```

`bun run typecheck` (`astro check`) validates frontmatter against the schema and
catches broken content references; run it before committing docs changes.

Docs describe the code in this repo. When behavior changes, the page documenting
it changes in the same commit — a reference page that has drifted from the CLI is
worse than no page.

## Known issues

Open work is tracked in `BACKLOG.md` at the repo root. Two items are recorded
there today, both on the event-stream path:

- **Event stream snapshot sizing.** The client WebSocket proxy applies the
  256 KiB `MAX_PENDING_BYTES` terminal limit to upstream frames buffered before
  the browser socket opens. The bridge sends the full fleet snapshot as one
  frame and agent status strings are unbounded, so a legitimate snapshot can
  exceed the limit and trigger a permanent reconnect loop.
- **Bridge event backpressure.** The bridge broadcasts events without checking
  `ServerWebSocket.send()` results or configuring backpressure. A slow browser
  can silently miss an update while staying connected, leaving its workspace
  state stale until it reconnects.

Read `BACKLOG.md` for the specific follow-ups listed under each.
