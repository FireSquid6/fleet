---
title: Running across several machines
description: Spread a fleet over many hosts — a ship per machine, one bridge fronting them, and the constraints that come with it.
sidebar:
  order: 8
---

A ship owns workspaces on exactly one machine. To spread a fleet across several,
run a ship on each host and register them all with a single bridge. The bridge
then presents one workspace API covering every host, and the GUI shows them side
by side.

## Start a ship on each host

On every machine that will host workspaces:

```bash
fleet ship --port 4700 --name build-box --fleet-directory /srv/fleet
```

Defaults are port `4700`, name `ship`, and `./fleet`. Two things matter here:

- **Give each ship a distinct `--name`.** The bridge keys its roster by the name
  the ship reports, and rejects a second ship claiming a name already registered.
  Leaving every host on the default `ship` means only the first one registers.
- **The URL you'll register must be reachable from the bridge's host.**
  `http://localhost:4700` only works when the bridge is on the same machine.

Ships on different hosts can all use port `4700` — the port collision rule only
applies to ships sharing a machine.

## Point the bridge at them

Two equivalent ways. From the CLI, against a running bridge:

```bash
fleet client --bridge-url http://control:4800 ships add http://build-box.internal:4700
fleet client --bridge-url http://control:4800 ships add http://gpu-box.internal:4700
```

Or declare them in `fleet-config.yaml` as remote ships, so `fleet launch`
registers them for you at startup:

```yaml
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: control

gui:
  port: 3000

ships:
  build-box:
    source: remote
    url: http://build-box.internal:4700

  gpu-box:
    source: remote
    url: http://gpu-box.internal:4700
```

`source: remote` means "already running elsewhere, just register it" — the launch
does not try to start it. You can mix: a `source: local` ship on the control host
alongside remote ones. See [Configuring a
fleet](/guides/configuring-a-fleet/) and [Managing
ships](/guides/managing-ships/).

Either way the bridge discovers each ship's name from its first event sync, and
persists the roster so it reconnects to all of them on restart.

## The `<repo>/<name>` uniqueness constraint

Within a ship, `(repo, name)` identifies a workspace. **Across a fleet,
`<repo>/<name>` must be unique globally** — the bridge maintains a single
ownership index mapping each key to exactly one ship, and that index is how it
routes every command. Two ships holding `api-gateway/feature-x` leaves the bridge
with no way to decide which one you meant.

The constraint is enforced at three moments:

**At bridge startup**, it is fatal. The bridge connects to every stored ship,
waits for their first syncs, and refuses to start if two reachable ships hold the
same key:

```
duplicate workspaces across ships:
  api-gateway/feature-x on build-box, gpu-box
```

Delete one of the two workspaces (or deregister one ship) and start again.

**At registration**, it is a rejection. Adding a ship whose workspaces collide
with keys already owned fails, and the ship is not adopted:

```
ship "gpu-box" has workspaces already hosted elsewhere: api-gateway/feature-x
```

**At creation**, it is a conflict. Creating a workspace through the bridge fails
if the key is already owned by any ship, or if another create for the same key is
already in flight.

**At runtime**, a collision that appears after startup — say a ship comes back
online holding a key another ship has since claimed — is not fatal. The bridge
keeps the existing owner, ignores the newcomer, and logs:

```
fleet-bridge: duplicate workspace "api-gateway/feature-x" reported by ship "gpu-box"; already owned by "build-box" — ignoring the newcomer
```

The practical rule: give workspaces names that are meaningful fleet-wide, not
per-host. `api-gateway/nightly-build` on one host and `api-gateway/nightly-build`
on another is the mistake this constraint exists to catch.

## What breaks when a host is unreachable

Registration of a host that isn't answering fails after a five-second wait:

```
ship at http://gpu-box.internal:4700 did not respond: timed out waiting for sync
```

Under `fleet launch` that's a warning, not a failure — the launch prints it and
brings the rest of the fleet up. Re-register the ship later with `fleet client
ships add` once the host is back.

For a ship that was already registered and then dropped off:

- It shows as `offline` in `fleet client ships ls` and on the GUI's Ships page,
  and its hardware blurb becomes `offline`.
- The bridge reconnects in the background with exponential backoff, capped at 30
  seconds between attempts, until you deregister it.
- Its workspaces **still appear** in `fleet client ls --wide` and in the GUI.
  Those rows are the bridge's last-known snapshot; they are not live.
- Any command routed to it fails with `ship "<name>" hosting <repo>/<name> is
  offline`. That covers status, diff, branch, activate, deactivate, delete, and
  the terminal.
- Creating a workspace on it is refused with `ship "<name>" is offline`.
- Fleet-wide system resources still list it, with null resources instead of
  failing the whole aggregate.

Workspaces on the unreachable host keep running — tmux sessions and agents are
unaffected by the bridge losing sight of them. Only fleet-level control is lost.
When the host returns, its first sync replaces the bridge's whole picture of that
ship in one shot.

One case needs care: if the connection drops *during* a create, the bridge can't
tell whether the ship completed the clone. It holds the key in an indeterminate
reservation and refuses further creates for it, telling you to wait for
confirmation or deregister the ship to clear it. Don't retry blindly — check the
host.

## Reachability, end to end

Three hops have to work:

1. Browser → GUI server. The GUI serves the app and proxies `/bridge/*`.
2. GUI server → bridge, over the `bridgeUrl` you configured.
3. Bridge → each ship, over the URL you registered, for both HTTP and WebSockets.

A terminal in the browser is piped browser → GUI → bridge → ship's tmux session,
so the WebSocket path must be open at every hop, not just HTTP.

:::caution
None of these hops is authenticated or encrypted. Anyone who can reach the bridge
can drive every registered ship, and anyone who can reach a ship can drive its
workspaces directly. Run a fleet on a trusted private network, and do not expose
a bridge or a ship to the internet.
:::

## Agents stay local to their ship

`fleet agent` finds its ship by walking up from the working directory to the
`atlas.json` the ship writes, and connects to `http://localhost:<port>`. It is
deliberately local-only: an agent must run on the same host as the ship that owns
its workspace. There is no remote form of these commands, and none is needed —
agents run inside the workspace's tmux session, which is on that host by
definition. See [Running agents](/guides/running-agents/).

## Related

- [Architecture](/concepts/architecture/) — how ships, the bridge, and the GUI
  fit together.
- [The bridge](/concepts/bridge/) — the ownership index and routing.
- [Managing ships](/guides/managing-ships/) — registration and offline behaviour
  in detail.
