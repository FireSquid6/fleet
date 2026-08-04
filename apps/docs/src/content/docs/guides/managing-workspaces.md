---
title: Managing workspaces
description: Create, list, inspect, activate, and delete workspaces from the fleet CLI.
sidebar:
  order: 2
---

A workspace is a git clone living at `<fleetDirectory>/<repo>/<name>` on a ship,
identified by the `(repo, name)` pair. It is **active** when a tmux session is up
for it and **inactive** when only the directory exists. See
[Workspaces](/concepts/workspaces/) for the model; this page is the command
walkthrough.

## Pointing the CLI at a ship or the bridge

Workspace commands live under `fleet client`, which carries two connection
options:

```bash
fleet client --url http://localhost:4700 ls          # one ship
fleet client --bridge-url http://localhost:4800 ls --wide   # the whole fleet
```

`--url` defaults to `http://localhost:4700` and `--bridge-url` to
`http://localhost:4800`. Both accept a bare port (`4700`), a `host:port`
(`build-box:4700`), or a full URL — the CLI normalizes them.

Because these are options on `fleet client` itself, they go *before* the
subcommand.

## List workspaces

```bash
fleet client ls
```

```
REPO         NAME       BRANCH        ACTIVE
api-gateway  feature-x  feature/auth  yes
api-gateway  hotfix     main          no
```

Filters and formats:

| Flag         | Effect |
| ------------ | ------ |
| `--active`   | only workspaces with a live tmux session |
| `--inactive` | only workspaces without one |
| `--wide`     | ask the bridge instead, listing every workspace across the fleet with its owning ship |
| `--json`     | print the raw rows as JSON instead of a table |

`--active` and `--inactive` are mutually exclusive; passing both exits with an
error. When nothing matches, the command prints `no workspaces`.

`--wide` adds a `SHIP` column and goes through `--bridge-url` rather than
`--url`:

```bash
fleet client --bridge-url http://localhost:4800 ls --wide
```

```
SHIP     REPO         NAME       BRANCH        ACTIVE
ship-a   api-gateway  feature-x  feature/auth  yes
gpu-box  api-gateway  bench      main          no
```

`--json` composes with everything, which is what you want for scripting:

```bash
fleet client ls --active --json
```

## Inspect one workspace

```bash
fleet client status api-gateway feature-x
```

```
repo:   api-gateway
name:   feature-x
branch: feature/auth
state:  active
ship:   ship-a
diff:   +142 -37 (2 commits ahead)
```

The `ship` and `diff` lines only appear for an active workspace — an inactive one
has no session and reports just repo, name, branch, and `state: inactive`. The
diff counts are lines added and removed against `HEAD` across the working tree,
plus how many commits the branch is ahead of its upstream (`0` when there is no
upstream).

## Create a workspace

```bash
fleet client create api-gateway feature-x \
  --url https://github.com/org/api-gateway.git \
  --branch main
```

`-u/--url` and `-b/--branch` are both required. The first positional argument is
the repo name — which is also the directory the clone lands under on the ship —
and the second is the workspace name.

```
created workspace api-gateway/feature-x on branch main
```

The branch is created off the repo's default branch if the remote doesn't have
it yet, so you can start a workspace on a branch that doesn't exist.

A fresh workspace starts **inactive**: the clone exists, but no tmux session does.

:::caution
`fleet client create` talks to a ship directly and takes an explicit clone URL.
It does not consult the bridge's repo registry. Creating a workspace *from a
registered repo* — the flow the web GUI uses — goes through the bridge instead;
see [Managing repos](/guides/managing-repos/).
:::

The create fails with a conflict if the destination directory already exists, so
`(repo, name)` is effectively unique per ship. Across a fleet, `<repo>/<name>`
must be unique globally — see [Running across several
machines](/guides/multi-host/).

## Switch branch

```bash
fleet client branch api-gateway feature-x feature/auth
```

```
switched api-gateway/feature-x to branch feature/auth
```

The branch is created if it doesn't already exist. This works whether or not the
workspace is active.

## Activate and deactivate

Activating starts the workspace's tmux session — this is what makes a terminal
attachable and what an agent needs before it can report status:

```bash
fleet client activate api-gateway feature-x
fleet client deactivate api-gateway feature-x
```

Activating an already-active workspace is an error, and so is deactivating an
inactive one.

Deactivating kills the tmux session and **clears the workspace's agent status** —
agent status is in-memory runtime state tied to the session, not something
persisted on disk. The next agent to attach starts from `init` again. See
[Running agents in a workspace](/guides/running-agents/).

## Delete a workspace

```bash
fleet client rm api-gateway feature-x
```

```
removed api-gateway/feature-x
```

This kills the tmux session if one is up, then recursively deletes the workspace
directory. Uncommitted or unpushed work in that clone is gone — nothing pushes
for you.

The ship also takes `?force=false` on that endpoint, which refuses the delete
with a `409` when the clone holds anything no remote has: a dirty working tree
(untracked files included), commits missing from every remote on *any* local
branch, or a stash. The CLI and the web GUI both delete unconditionally — the
non-forcing form is what the bridge's ephemeral cleanup uses.

## Ephemeral workspaces

When you create a workspace from an issue in the web GUI, **Ephemeral** is
ticked by default. The bridge then deletes that workspace on its own once every
pull request on the linked branch has closed — or, if no pull request was ever
opened, once the issue itself closes. See
[Workspaces](/concepts/workspaces/#ephemeral-workspaces) for the exact rules.

Ephemeral workspaces are labelled wherever they appear, with the issue and the
pull request the last sweep saw:

```
◇ ws-9c11  ⧗ EPHEMERAL   issue #88 · PR #214 open
```

Cleanup never destroys work the remote does not have. When it is refused, the
workspace stays put and the label turns red with the reason:

```
◇ ws-a071  ⚠ EPHEMERAL   issue #41 · PR #118 closed ·
                         cleanup blocked: 2 commits not on any remote
```

That is a state you resolve, not one the fleet resolves for you: push the branch
(or delete the workspace yourself), and the next sweep clears it. To check
immediately rather than waiting for the timer:

```bash
curl -X POST http://localhost:4800/workspaces/sweep
```

```json
{ "checked": 3, "destroyed": 1, "blocked": 1, "skipped": 0, "forgotten": 0 }
```

## Where this maps in the API

Every command above is a thin wrapper over one ship endpoint
(`GET /workspaces`, `POST /workspaces/:repo/:name/activate`, and so on). The
bridge exposes a superset of the same surface with the owning ship visible on
each row. See [the ship API](/reference/ship-api/) and [the bridge
API](/reference/bridge-api/).
