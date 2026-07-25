---
title: Packages
description: A map of every workspace in the Fleet monorepo and what each one is responsible for.
sidebar:
  order: 1
---

Fleet is a [Bun](https://bun.com) monorepo. The root `package.json` declares two
workspace globs — `packages/*` and `apps/*` — so every directory below is a
workspace resolved by name (`git-bun`, `fleet-ship`, …) rather than by relative
path.

Four of these packages are general-purpose libraries with no Fleet-specific
knowledge: `git-bun`, `tmux-bun`, `bun-vt`, and `webterm`. They are documented
here as libraries, with their own API pages. The rest are the Fleet services
themselves, documented under [Concepts](/concepts/architecture/) and
[Reference](/reference/ship-api/).

## Workspaces

| Workspace | Role |
| --- | --- |
| [`packages/git-bun`](/packages/git-bun/) | Typed, directory-bound wrapper around the git CLI. Every handle is confined to one working directory. |
| [`packages/tmux-bun`](/packages/tmux-bun/) | Typed, headless wrapper around the tmux CLI. Every handle is confined to its own private tmux server. |
| [`packages/bun-vt`](/packages/bun-vt/) | Pure-TypeScript VT terminal emulator: escape-sequence parser plus screen/grid model. No native code, no FFI. |
| [`packages/webterm`](/packages/webterm/) | The JSON-over-WebSocket terminal protocol plus the server-side bridge that turns a PTY into streamed grid snapshots. |
| `packages/fleet-protocol` | The shared contract — Zod schemas and types for workspaces, repos, ships, agent status, events, and config — imported by the ship, bridge, client, and CLI. See [Protocol reference](/reference/protocol/). |
| `packages/fleet-ship` | The per-host daemon. Owns repos, workspaces, tmux sessions, and the workspace HTTP + WebSocket API. See [Ships](/concepts/ships/) and the [Ship API](/reference/ship-api/). |
| `packages/fleet-bridge` | The fleet-wide orchestrator: one endpoint fronting many ships, with automatic routing and a persisted ship roster. See [Bridge](/concepts/bridge/) and the [Bridge API](/reference/bridge-api/). |
| `packages/fleet-client` | The React web GUI (canvas terminal, workspace tree, diff view) and the Bun server that serves it. See [Web GUI](/guides/web-gui/). |
| `apps/cli` | The `fleet` binary — a Commander CLI over the ship and bridge APIs, plus `fleet launch`. See [CLI reference](/reference/cli/). |
| `apps/docs` | This documentation site (Astro + Starlight). See [Development](/contributing/development/). |

## How they depend on each other

The libraries sit at the bottom and know nothing about Fleet:

- `bun-vt` has no dependencies at all.
- `webterm` depends on `bun-vt` (to emulate the terminal server-side) and `zod`
  (to validate wire frames).
- `git-bun` and `tmux-bun` depend on nothing but Bun itself.

The services build on top:

- `fleet-ship` uses `git-bun` (repos and workspace clones), `tmux-bun`
  (workspace sessions), `webterm` (the terminal WebSocket), and
  `fleet-protocol`.
- `fleet-bridge` uses `git-bun`, `fleet-ship`, `webterm` (it proxies terminal
  frames rather than emulating them), and `fleet-protocol`.
- `fleet-client` uses `webterm/protocol` — the browser-safe, type-only half of
  webterm — plus `fleet-protocol` and `fleet-bridge` for typed API access.
- `apps/cli` depends on all four services, which is what lets `fleet launch`
  start a bridge, ships, and the GUI in one process.

## Working on a package

Every workspace exposes the same two scripts, and the root runs them across all
workspaces at once:

```bash
bun install       # once, from the repo root
bun test          # every workspace's suite
bun typecheck     # every workspace's tsc --noEmit
```

To run just one package's suite, run it from that package's directory:

```bash
cd packages/git-bun
bun test
```

The `git-bun` and `tmux-bun` end-to-end suites shell out to real `git`/`tmux`
binaries against throwaway directories and sockets, and skip gracefully when the
binary is not installed.
