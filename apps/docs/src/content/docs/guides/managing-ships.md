---
title: Managing ships
description: Register ships with the bridge by URL, list them, deregister them, and understand what happens when one goes offline.
sidebar:
  order: 3
---

The bridge keeps a roster of ships. Registering a ship means handing the bridge a
URL; the bridge connects, learns the ship's name from its event stream, and
persists the entry. Everything here runs through `fleet client ships`, which
talks to the bridge.

## Point the CLI at the bridge

```bash
fleet client --bridge-url http://localhost:4800 ships ls
```

`--bridge-url` is an option on `fleet client`, so it goes before the subcommand.
It defaults to `http://localhost:4800` and accepts a bare port, a `host:port`, or
a full URL. The examples below omit it and assume the default.

## List ships

```bash
fleet client ships ls
```

```
NAME     URL                            STATUS
ship-a   http://localhost:4700          online
gpu-box  http://gpu-box.internal:4700   offline
```

`--json` prints the raw rows instead. With an empty roster the command prints
`no ships`.

`STATUS` is not a stored field — it reflects whether the bridge currently has a
live `/events` WebSocket to that ship, right now.

## Register a ship

```bash
fleet client ships add http://gpu-box.internal:4700
```

```
registered ship gpu-box (http://gpu-box.internal:4700)
```

You supply only the URL. The bridge opens the ship's `/events` socket, waits for
the first sync — which carries the ship's own configured name and its current
workspace list — and adopts it under that name. That's why the printed name may
differ from anything in your command: it comes from the ship's `--name`, not from
you.

Registration is rejected in three cases:

| Situation | Response |
| --------- | -------- |
| No sync within 5 seconds | `ship at <url> did not respond: timed out waiting for sync` |
| A ship with that name is already registered | `ship already registered: <name>` |
| The ship holds a `<repo>/<name>` that another ship already owns | `ship "<name>" has workspaces already hosted elsewhere: <keys>` |

The last one is the fleet-wide uniqueness rule; see [Running across several
machines](/guides/multi-host/).

Registration is persisted immediately to `ships.json` under the bridge's data
directory, so the roster survives a bridge restart. On restart the bridge
reconnects to every stored ship.

`fleet launch` performs this same registration for every ship in your
`fleet-config.yaml`, local or remote — see [Configuring a
fleet](/guides/configuring-a-fleet/). You can also add a ship from the web GUI's
**Ships** page.

## Deregister a ship

```bash
fleet client ships rm gpu-box
```

```
removed ship gpu-box
```

Note the argument is the ship's **name**, not its URL. The bridge closes the
connection, drops that ship's workspaces from its ownership index, and rewrites
the persisted roster. Removing a ship from the bridge does not touch the ship
process or any workspace on disk — the ship keeps running, it is just no longer
part of this fleet.

Removing a non-existent ship reports `ship not found: <name>`.

## When a ship goes offline

The bridge does not forget a ship that stops answering. When the `/events` socket
closes:

- The ship flips to `offline` in `fleet client ships ls`.
- The bridge starts reconnecting with exponential backoff, capped at 30 seconds
  between attempts. It keeps trying until the ship is deregistered.
- The workspaces the bridge last saw on that ship **stay** in `fleet client ls
  --wide`. Those rows are the last-known snapshot, not live state.
- Any command routed to that ship — activate, deactivate, branch, delete, status,
  diff, terminal — fails with `ship "<name>" hosting <repo>/<name> is offline`.
- Creating a workspace on it is refused with `ship "<name>" is offline`.
- Aggregate system resources still list the ship, with its resources reported as
  null rather than failing the whole request.

A failed command can also *cause* the status flip: if the bridge's HTTP call to a
ship throws at the network level, it marks that connection offline immediately
rather than waiting for the socket to notice.

When the ship comes back, its first sync replaces the bridge's whole picture of
that ship — workspaces created or deleted while it was unreachable are picked up
in one shot.

:::caution
Nothing in the ship or bridge API is authenticated. A registered ship URL is
fully controllable by anyone who can reach the bridge, and the bridge can drive
any ship it can reach. Keep both on a trusted network.
:::

## Related

- [Managing repos](/guides/managing-repos/) — the other bridge-owned registry.
- [The bridge](/concepts/bridge/) — how routing and the ownership index work.
- [Bridge API reference](/reference/bridge-api/) — the `/ships` endpoints.
