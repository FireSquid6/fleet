---
title: Installation
description: Install the Fleet CLI and the tools it drives.
sidebar:
  order: 2
---

Fleet ships as a single binary, `fleet`, built from the monorepo. There is no
published package yet — you build it from a checkout.

## Prerequisites

| Tool | Needed for |
| --- | --- |
| [Bun](https://bun.com) | everything — Fleet is a Bun monorepo and the CLI is compiled with `bun build --compile` |
| `git` | cloning workspaces, branch switching, and diffs |
| `tmux` | activating workspaces and attaching terminals to them |

The lockfile in this repo was produced with Bun 1.3.x; use that or newer.

`git` and `tmux` are spawned as plain subprocesses (`git-bun` and `tmux-bun`
wrap the CLIs), so both must be on `PATH` of any machine that runs a **ship**.
A machine that only runs a bridge or the GUI needs neither: the bridge never
touches a working tree, and the GUI only proxies to the bridge.

:::caution
Without `tmux`, workspaces can still be created and inspected, but
`fleet client activate` and the browser terminal will fail — a workspace's
active/inactive state *is* the presence of its tmux session.
:::

Fleet drives tmux headlessly inside its own server namespace (`-L fleet-ship`),
so its sessions never appear in, or interfere with, your personal tmux server.

## Get the source

```bash
git clone https://github.com/firesquid6/fleet.git
cd fleet
bun install
```

## Install the `fleet` binary

`apps/cli/local-install.sh` builds the CLI and drops it in `~/.local/bin`:

```bash
./apps/cli/local-install.sh
```

The script compiles `apps/cli/src/index.ts` into a standalone executable at
`apps/cli/out/fleet` (via `apps/cli/build.ts`, which runs `Bun.build` with
`compile: true` and the Tailwind plugin so the GUI bundle is embedded), copies
it to `~/.local/bin/fleet`, and removes any stale `~/.local/bin/fleet-agent`
from older versions.

Make sure `~/.local/bin` is on your `PATH`, then check the install:

```bash
fleet --help
```

Rebuild the same way after pulling changes — the binary is a snapshot, not a
symlink into the repo.

## Run from source instead

For development you can skip the build entirely and run the entry point
directly. Every command below behaves the same as the compiled binary:

```bash
bun apps/cli/src/index.ts --help
bun apps/cli/src/index.ts ship --port 4700
```

See [Development](/contributing/development/) for the rest of the repo
workflow.

## Agent integrations

Starting a ship installs the `fleet-agent` skill — and a startup plugin, for
providers that have one — into each agent provider's config directory
(`claude-code`, `opencode`, `copilot`, `codex`). Failures are warnings, never
fatal: the ship still boots.

To inspect or repair those installs without starting a ship:

```bash
fleet ship plugin doctor
fleet ship plugin install all
fleet ship plugin install claude-code --force
```

`doctor` is read-only and also reports whether each provider's CLI is on
`PATH`. `install` refuses to overwrite a file it does not own; pass `--force`
to replace it. Details in [Agent integrations](/guides/agent-integrations/).

## Next

Bring up a fleet in [Quickstart](/start/quickstart/).
