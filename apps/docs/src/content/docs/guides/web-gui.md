---
title: Running the web GUI
description: Serve the Fleet dashboard, point it at a bridge, and use it to watch and drive workspaces.
sidebar:
  order: 5
---

The GUI is a React single-page app served by its own small Bun server. That
server does two things: it serves the app bundle, and it reverse-proxies
`/bridge/*` to a real bridge. Everything the browser sees comes from the bridge.

## Start it

Standalone:

```bash
fleet client serve --url http://localhost:4800
```

`--url` is the **bridge** origin to proxy to and defaults to
`http://localhost:4800`. It accepts a bare port, a `host:port`, or a full URL.
The server prints where it landed:

```
Started client on http://localhost:3000/, forwarding to http://localhost:4800
```

`fleet client serve` has no port flag. To pin a port, run the GUI from a
`fleet-config.yaml` instead:

```yaml
bridge:
  port: 4800

gui:
  port: 3000
  # bridgeUrl: http://other-host:4800   # defaults to the bridge above
```

```bash
fleet launch
```

When `gui.bridgeUrl` is omitted, the GUI proxies to the bridge that same launch
started. Declaring a `gui` with neither a `bridge` section nor a `bridgeUrl` is a
config error. See [Configuring a fleet](/guides/configuring-a-fleet/).

## What it proxies

Every request the browser makes to `/bridge/<path>` is forwarded to
`<bridgeUrl>/<path>`, method, headers, and body intact. That includes WebSocket
upgrades — both the `/events` stream and the per-workspace terminal socket are
piped through, bridge to ship, ship to browser.

Because the app only ever talks to its own origin, the bridge needs no CORS
configuration.

Every other path serves the app bundle, so deep links like
`/repos/api-gateway/workspaces/feature-x` survive a refresh.

If the bridge is unreachable, the proxy answers with a `502` and a JSON body
explaining which URL failed, and the app shows the message in a banner.

:::caution
The GUI server does no authentication and neither does the bridge. Anyone who can
reach the GUI can create, activate, and delete workspaces, and can type into any
workspace's terminal. Bind it somewhere private.
:::

## What it shows

### Bridge

The landing page is a repo × ship grid. Each cell holds the workspaces for that
repo on that ship, each shown as a node coloured by its agent state, plus a `+`
that opens **New Workspace** pre-filled with that repo and ship. The header
counts active sessions against the total.

On narrow screens the grid collapses into a stacked card per repo.

### Repos

A table of the bridge's registered repos — name, clone URL, provider — with a
**New Repo** dialog and a per-row delete. Same operations as
[`fleet client repos`](/guides/managing-repos/).

### Ships

A table of registered ships with a status dot (`online` / `offline`) and a
hardware blurb — core count, memory, architecture — pulled from the ship's system
resources. Offline ships show `offline` in place of the blurb. **New Ship** takes
just a URL; the bridge discovers the ship's name itself. See [Managing
ships](/guides/managing-ships/).

### Repo detail

Every workspace for one repo, in a wide table: workspace, branch, ship, session
state, and the agent's state, description, model, provider, and harness. Above
it, counts of workspaces, active sessions, and distinct ships. **New Workspace**
creates against a registered repo — the ship is a dropdown when you start here.

### Workspace detail

The header carries the branch, the owning ship, the live agent state and
description, and the model/provider/harness the agent registered with. Alongside
it: an **Activate** / **Stop** button, **Switch Branch**, **Delete**, and a strip
of sibling workspaces in the same repo so you can jump between them.

Below that, two tabs:

- **Terminal** — attaches to the workspace's tmux session over the proxied
  WebSocket. Only one terminal connection per workspace session is allowed; a
  second tab attaching to the same workspace is closed. When the workspace is
  inactive there is no session to attach to, so the pane offers an **Activate
  session** button instead. See [Terminals](/concepts/terminals/).
- **Diff** — the workspace's working-tree diff against `HEAD`, including
  untracked files. A file list on the left shows added/modified/deleted/renamed
  and per-file line counts; selecting a file shows its hunks. The diff is fetched
  when the tab opens and re-fetched with **refresh** — it does not stream.

Switching tabs unmounts the other one. The terminal re-attaches on switch-back
because the tmux session lives on the ship, not in the browser.

## Live updates

On load the app fetches ships, repos, and workspaces, then subscribes to the
bridge's `/events` WebSocket. Workspace creations, branch changes,
activations, deactivations, agent status changes, and removals are applied to the
in-memory list as they arrive, so the grid nodes, repo counts, sibling dots, and
the sidebar's "N sessions live" counter all move together without a reload.

If the stream drops, the app reconnects with exponential backoff (capped at 30
seconds) and shows the error until a fresh `sync` arrives. See
[Events](/concepts/events/) for the event union itself.

Ship and repo lists are refreshed after a mutation rather than streamed — they
are not part of the event stream.
