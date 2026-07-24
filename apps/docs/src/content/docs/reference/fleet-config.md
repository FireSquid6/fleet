---
title: fleet-config.yaml reference
description: The complete schema fleet launch reads, with every field, default, and validation error.
sidebar:
  order: 4
---

`fleet launch` reads a single YAML file describing a whole fleet — an optional
`bridge`, an optional `gui`, and an optional map of `ships` — and starts
everything in one process. The file defaults to `./fleet-config.yaml`; override
it with `fleet launch --config-path <path>`.

Every top-level section is optional. Only the sections present are started:
`fleet launch` on an empty file (`{}`) starts nothing and exits.

## Scaffold

`fleet launch init` writes this file verbatim. It is a valid config as written.

```yaml
# fleet-config.yaml — configuration for `fleet launch`.
# Every section is optional; only the sections present are started.

# The fleet-wide bridge that coordinates ships and serves the fleet API.
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: my-fleet-bridge

# The web gui. Proxies to the bridge above by default.
gui:
  port: 3000
  # bridgeUrl: http://localhost:4800  # defaults to the local bridge

# Ships that host workspaces. Each key is the ship's default name.
ships:
  ship-a:
    # source: local (the default) spawns the ship in this process.
    source: local
    fleetDirectory: ./fleet/ship-a
    port: 4700
    # name: ship-a  # defaults to the key above

  # source: remote registers an already-running ship by URL instead of spawning it.
  # ship-b:
  #   source: remote
  #   url: http://another-host:4700
```

## Top level

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `bridge` | object | no | absent | Start a bridge in this process. |
| `gui` | object | no | absent | Serve the web GUI in this process. |
| `ships` | map of string → object | no | `{}` | Ships to start and/or register. |

`bridge:` and `gui:` written with no body parse to `null` in YAML; both are
treated as "enabled with defaults" rather than an error. `ships:` with no body
is not given this treatment.

## `bridge`

Every field has a default, so `bridge: {}` is valid.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `dataDirectory` | string (non-empty) | no | `./.fleet/bridge` | Where the bridge persists `ships.json` and `repos.json`. Resolved to an absolute path. |
| `port` | integer | no | `4800` | Port the bridge's HTTP + WebSocket API listens on. |
| `name` | string (non-empty) | no | `bridge` | Human-facing name of the bridge. |

:::note
The `dataDirectory` default here (`./.fleet/bridge`) is *not* the same as the
`fleet bridge` CLI default (`./.fleet-bridge`). They are separate defaults in
separate code paths.
:::

## `gui`

Both fields are optional, so `gui: {}` is valid — as long as a bridge exists to
proxy to.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `port` | integer | no | none — Bun picks the port | Port the GUI listens on. |
| `bridgeUrl` | string (non-empty) | no | `http://localhost:<bridge.port>` | Bridge the GUI reverse-proxies `/bridge/*` to. |

When `bridgeUrl` is omitted, the GUI targets the launched local bridge. That is
why a `gui` section with neither a `bridge` section nor a `bridgeUrl` is a
validation error — there would be nothing to point it at.

The value is normalized like every other Fleet URL: a bare port becomes
`http://localhost:<port>`, a bare host:port gains an `http://` scheme, and a
full URL is used as-is.

## `ships`

A map, not a list. Each key names a ship and supplies the defaults for that
entry: the key becomes the ship's `name` and, for local ships, its
`fleetDirectory` (`./fleet/<key>`).

Each value is one of two shapes, discriminated by `source`. When `source` is
omitted the entry is treated as `local`, so `ship-a: {}` is a complete, valid
ship.

### `source: local`

The ship is spawned inside the `fleet launch` process.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `source` | `"local"` | no | `local` | Discriminator. |
| `fleetDirectory` | string (non-empty) | no | `./fleet/<key>` | Directory holding this ship's workspaces (`<dir>/<repo>/<name>`). Resolved to an absolute path. |
| `port` | integer | no | `4700` | Port this ship listens on. |
| `name` | fleet identifier | no | the map key | Human-facing name of this ship. |

Because `port` defaults to `4700` for every local ship, two or more local ships
must each set a distinct `port`.

### `source: remote`

The ship is already running elsewhere; `fleet launch` only registers it with the
bridge.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `source` | `"remote"` | yes | — | Discriminator. Must be written explicitly; omitting it makes the entry `local`. |
| `url` | string (non-empty) | yes | — | Base URL of the running ship. |

Remote entries accept no other fields — no `port`, no `name`, no
`fleetDirectory`. The ship's name is discovered by the bridge from the ship's
own `sync` event, not taken from the map key.

## Validation errors

Zod rejects a malformed file before anything starts; the CLI prints
`fleet launch: <message>` and exits 1.

| Error | Raised when |
| --- | --- |
| `config file not found: <path>` | The path given by `--config-path` (or `./fleet-config.yaml`) does not exist. |
| `failed to parse config file <path> as YAML: <message>` | The file is not valid YAML. |
| `ships "<a>" and "<b>" both use port <port>; give each local ship a distinct port` | Two `source: local` ships share a port. Remote ships are exempt — they have no port field. |
| `gui is configured with no bridge to proxy to; add a bridge section or gui.bridgeUrl` | A `gui` section exists with neither a `bridge` section nor `gui.bridgeUrl`. |
| a zod issue list | Any schema violation: `source: remote` with no `url`; a non-integer `port`; an empty `dataDirectory`, `fleetDirectory`, `name`, `url`, or `bridgeUrl`; a `name` that is not a valid [fleet identifier](/reference/protocol/); an unknown `source` value. |

Ordering matters when reading a failure: schema parsing runs first, then the
duplicate-port check, then the gui/bridge check.

## What launch actually does

1. Loads and normalizes the config.
2. If `bridge` is present, starts the bridge and keeps its manager.
3. For each ship in map order: starts it if `source: local`, then registers it
   with the bridge at `http://localhost:<port>` (local) or its `url` (remote),
   printing `registered ship "<key>" (<url>) with the bridge`.
4. If `gui` is present, serves the GUI against `gui.bridgeUrl` or the local
   bridge.

Two non-fatal cases to expect in the log:

- With no `bridge` section, each ship logs
  `no bridge configured; not registering ship "<key>" (<url>)` — local ships
  still start.
- A registration that throws logs
  `could not register ship "<key>" (<url>): <message>` and the launch continues
  with the next ship.

## Examples

A single machine running everything:

```yaml
bridge:
gui:
  port: 3000
ships:
  local:
```

That is a bridge on `4800` with data in `./.fleet/bridge`, a GUI on `3000`
proxying to it, and one ship named `local` on `4700` with workspaces under
`./fleet/local`.

Two local ships plus one already-running remote ship:

```yaml
bridge:
  port: 4800
gui:
  port: 3000
ships:
  ship-a:
    port: 4700
  ship-b:
    port: 4701
    fleetDirectory: /srv/fleet/ship-b
  builder:
    source: remote
    url: http://10.0.0.7:4700
```

A GUI-only process pointed at a bridge on another host:

```yaml
gui:
  port: 3000
  bridgeUrl: http://bridge.internal:4800
```

See [configuring a fleet](/guides/configuring-a-fleet/) for the task-oriented
walkthrough, and [multi-host](/guides/multi-host/) for spreading ships across
machines.
