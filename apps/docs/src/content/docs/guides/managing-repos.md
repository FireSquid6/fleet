---
title: Managing repos
description: Register git repos with the bridge so workspaces can be created from them by name.
sidebar:
  order: 4
---

The bridge keeps a registry of the repos a fleet can create workspaces from. A
repo record is three fields — a unique `name`, a git clone `url`, and a
`provider` label — and it lives in `repos.json` under the bridge's data
directory, so it survives restarts.

The `name` matters beyond bookkeeping: it is also the directory a clone lands
under on the ship, at `<fleetDirectory>/<name>/<workspace>`.

## Point the CLI at the bridge

Repo commands live under `fleet client repos` and go through the bridge:

```bash
fleet client --bridge-url http://localhost:4800 repos ls
```

`--bridge-url` defaults to `http://localhost:4800`. The examples below assume the
default.

## Register a repo

```bash
fleet client repos add api-gateway https://github.com/org/api-gateway.git --provider github
```

```
registered repo api-gateway (https://github.com/org/api-gateway.git)
```

The first argument is the name, the second is the clone URL. `-p/--provider` is
optional and is a free-form string describing where the repo is hosted; when
omitted, the bridge stores `custom`.

Names must be unique — re-adding an existing name is rejected with `repo already
registered: <name>`. The name is also validated as a fleet identifier: no path
separators, no control characters, not `.` or `..`, at most 128 UTF-8 bytes.

## List repos

```bash
fleet client repos ls
```

```
NAME         URL                                          PROVIDER
api-gateway  https://github.com/org/api-gateway.git       github
tooling      git@github.com:org/tooling.git               custom
```

`--json` prints the raw records instead. An empty registry prints `no repos`.

## Remove a repo

```bash
fleet client repos rm api-gateway
```

```
removed repo api-gateway
```

Removing a repo that isn't registered reports `repo not found: <name>`.

:::caution
Deregistering a repo only deletes the registry entry. Workspaces already cloned
from it keep running, and their directories stay on disk under the old repo name.
Delete those separately with `fleet client rm <repo> <name>`.
:::

## How a registered repo relates to creating a workspace

There are two ways to create a workspace, and only one of them uses the registry.

**Through the bridge (uses the registry).** The bridge's create takes a ship, a
registered `repoName`, a workspace name, and a branch — but no URL. It looks the
repo up in its registry, and passes that repo's stored `url` down to the chosen
ship as the clone source. If the name isn't registered, the request fails with
`unknown repo: <name>`. This is the path the web GUI's **New Workspace** dialog
takes, which is why a repo has to exist in the registry before it shows up as
something you can create against in the GUI.

**Directly against a ship (ignores the registry).** The CLI's
`fleet client create` targets a ship and requires an explicit `-u/--url`:

```bash
fleet client create api-gateway feature-x \
  -u https://github.com/org/api-gateway.git -b main
```

Nothing checks that `api-gateway` is a registered repo here — the ship just
clones the URL you gave it into a directory of that name. See [Managing
workspaces](/guides/managing-workspaces/).

In practice: register a repo once so the GUI and the bridge-side create can use
it by name, and keep the registered `name` identical to the repo name you use in
CLI creates so the two paths land in the same directory on disk.

## Related

- [Managing workspaces](/guides/managing-workspaces/) — creating and driving
  workspaces.
- [Running the web GUI](/guides/web-gui/) — the **Repos** page does the same
  three operations from the browser.
- [Bridge API reference](/reference/bridge-api/) — the `/repos` endpoints.
- [Protocol reference](/reference/protocol/) — the `Repo` schema.
