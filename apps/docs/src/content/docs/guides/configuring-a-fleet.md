---
title: Configuring a fleet
description: Describe a whole fleet — bridge, ships, and GUI — in one fleet-config.yaml and bring it up with fleet launch.
sidebar:
  order: 1
---

`fleet launch` reads a single `fleet-config.yaml` and starts everything it
describes in one process: a bridge, any number of ships, and the web GUI. Ships
that the launch starts itself are registered with the bridge automatically.

This page covers the config format. For the individual `fleet ship` /
`fleet bridge` / `fleet client serve` flags, see [the CLI
reference](/reference/cli/); for the exhaustive field table, see [the config
reference](/reference/fleet-config/).

## Scaffold a config

```bash
fleet launch init
```

That writes a commented `./fleet-config.yaml`. It refuses to clobber an existing
file unless you pass `--force`, and `--config-path <path>` writes somewhere else.

Then bring the fleet up:

```bash
fleet launch
```

`fleet launch` also takes `--config-path <path>`; it defaults to
`./fleet-config.yaml`. The process stays in the foreground — the bridge, ships,
and GUI are all servers listening in it.

## The three sections

Every section is optional, and only the sections present are started:

```yaml
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: my-fleet-bridge

gui:
  port: 3000

ships:
  ship-a:
    fleetDirectory: ./fleet/ship-a
    port: 4700
```

A section key with no body (`bridge:` on its own line) parses as "enabled with
defaults" rather than an error, so a minimal single-machine config is:

```yaml
bridge:
gui:
ships:
  ship-a:
```

### `bridge`

| Field           | Default            | Meaning |
| --------------- | ------------------ | ------- |
| `dataDirectory` | `./.fleet/bridge`  | Where `ships.json` and `repos.json` are persisted. Resolved to an absolute path. |
| `port`          | `4800`             | HTTP + WebSocket port. |
| `name`          | `bridge`           | Human-facing name of the bridge. |

The directory is created on startup if it doesn't exist.

:::note
The standalone `fleet bridge` command defaults its `--data-directory` to
`./.fleet-bridge`, not `./.fleet/bridge`. If you switch between `fleet launch`
and `fleet bridge`, point them at the same directory explicitly or they will
each keep their own roster.
:::

### `gui`

| Field       | Default                        | Meaning |
| ----------- | ------------------------------ | ------- |
| `port`      | chosen by Bun                  | Port the GUI listens on. |
| `bridgeUrl` | the bridge started by this launch | Bridge origin the GUI reverse-proxies to. |

See [Running the web GUI](/guides/web-gui/) for what the GUI serves.

### `ships`

`ships` is a **map**, not a list. Each key names a ship, and the key supplies the
defaults for that entry:

```yaml
ships:
  ship-a:
    source: local
    fleetDirectory: ./fleet/ship-a
    port: 4700
    name: ship-a

  ship-b:
    source: remote
    url: http://build-box:4700
```

`source` defaults to `local` when omitted, so an entry with no `source` key is a
local ship.

**Local ships** (`source: local`) are started inside the `fleet launch` process:

| Field            | Default              |
| ---------------- | -------------------- |
| `fleetDirectory` | `./fleet/<key>`, resolved to an absolute path |
| `port`           | `4700`               |
| `name`           | the map key          |

**Remote ships** (`source: remote`) are not started — they must already be
running somewhere. The only field is `url`, and it is required. The bridge
connects to that URL and discovers the ship's real name from its first event
sync, so the map key is just a label in your config for a remote entry.

## Validation rules

`fleet launch` fails fast, before starting anything, on two cross-section
problems:

- **Two local ships on the same port.** Every `source: local` ship needs its own
  port, since they all run in one process on one machine:

  ```
  ships "ship-a" and "ship-b" both use port 4700; give each local ship a distinct port
  ```

  Remote ships are exempt — they're on other machines.

- **A GUI with nothing to proxy to.** If you declare `gui` without a `bridge`
  section, you must give it an explicit `bridgeUrl`:

  ```
  gui is configured with no bridge to proxy to; add a bridge section or gui.bridgeUrl
  ```

Ship registration failures are *not* fatal. If a ship can't be reached or its
name collides with one already registered, `fleet launch` prints a warning and
keeps going:

```
could not register ship "ship-b" (http://build-box:4700): ship at http://build-box:4700 did not respond: timed out waiting for sync
```

If there is no `bridge` section at all, ships are still started, but nothing
registers them:

```
no bridge configured; not registering ship "ship-a" (http://localhost:4700)
```

## Worked example: one machine

Everything on a laptop — a bridge, one ship, and the GUI:

```yaml
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: laptop

gui:
  port: 3000

ships:
  local:
    fleetDirectory: ./fleet/local
    port: 4700
```

```bash
fleet launch
```

The GUI is on `http://localhost:3000`, proxying to the bridge on `4800`, which
drives the ship on `4700`. Workspaces land under `./fleet/local/<repo>/<name>`.

## Worked example: a bridge fronting several ships

Two ships on this machine plus two already running elsewhere:

```yaml
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: control

gui:
  port: 3000

ships:
  local-a:
    port: 4700
    fleetDirectory: ./fleet/a

  local-b:
    port: 4701
    fleetDirectory: ./fleet/b

  gpu-box:
    source: remote
    url: http://gpu-box.internal:4700

  build-box:
    source: remote
    url: http://build-box.internal:4700
```

The two local ships need distinct ports; the remote ones each need a URL the
bridge host can actually reach. See [Running across several
machines](/guides/multi-host/) for what happens when one of them is down, and
for the fleet-wide `<repo>/<name>` uniqueness rule.

## What launch does *not* do

`fleet launch` registers ships with the bridge. It does not register repos — the
bridge's repo registry is managed separately, and it persists in the bridge's
`dataDirectory` across restarts. See [Managing repos](/guides/managing-repos/).
