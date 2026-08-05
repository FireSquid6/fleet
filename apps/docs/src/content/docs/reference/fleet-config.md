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
  # publicUrl: http://this-host:4800  # how ships reach this bridge; required if any ship is on another host
  # insecureNoAuth: true  # DEV ONLY: serve every route unauthenticated and skip creating the first admin

# The web gui. Proxies to the bridge above by default.
gui:
  port: 3000
  # bridgeUrl: http://localhost:4800  # defaults to the local bridge

# Ships that host workspaces. Each key is the ship's default name.
# A ship's shipToken/bridgeToken are set together or not at all, and ${VAR} reads
# the value from the environment so the secret never has to live in this file.
ships:
  ship-a:
    # source: local (the default) spawns the ship in this process.
    source: local
    fleetDirectory: ./fleet/ship-a
    port: 4700
    # name: ship-a  # defaults to the key above
    # shipToken: ${SHIP_A_SHIP_TOKEN}      # pin this ship's credentials instead of generating a fresh pair
    # bridgeToken: ${SHIP_A_BRIDGE_TOKEN}  # launch fails if a referenced variable is unset

  # source: remote registers an already-running ship by URL instead of spawning it.
  # ship-b:
  #   source: remote
  #   url: http://another-host:4700
  #   shipToken: ${SHIP_B_SHIP_TOKEN}      # the credentials that ship was already started with
  #   bridgeToken: ${SHIP_B_BRIDGE_TOKEN}  # must equal the ship's own FLEET_BRIDGE_TOKEN
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
| `dataDirectory` | string (non-empty) | no | `./.fleet/bridge` | Where the bridge persists `ships.json` and `repos.json`, and where its `armory/` directory lives. Resolved to an absolute path. |
| `port` | integer | no | `4800` | Port the bridge's HTTP + WebSocket API listens on. |
| `name` | string (non-empty) | no | `bridge` | Human-facing name of the bridge. |
| `publicUrl` | string (non-empty) | no | `http://localhost:<port>` | URL **ships** use to reach this bridge. |
| `insecureNoAuth` | boolean | no | absent (authentication required) | Development only: serve every route unauthenticated, and skip creating the first admin. |

:::note
The `dataDirectory` default here (`./.fleet/bridge`) is *not* the same as the
`fleet bridge` CLI default (`./.fleet-bridge`). They are separate defaults in
separate code paths.
:::

### `publicUrl`

`publicUrl` is handed to each ship so it can pull the
[armory](/guides/the-armory/), so it has to resolve **from the ships' hosts**,
not from the machine running the launch. The default,
`http://localhost:<bridge.port>`, is correct for a single-host fleet and wrong
the moment a `source: remote` ship is on another machine — there, `localhost` is
that machine.

Getting it wrong fails quietly: the ship registers, its workspaces work, and only
the armory never arrives. So `fleet launch` warns when a config declares one or
more `source: remote` ships and sets no `publicUrl`:

```
fleet launch: bridge.publicUrl is not set, so remote ships "build-box", "gpu-box" will be told this bridge is at http://localhost:4800, which on their hosts is themselves; set bridge.publicUrl to a URL those hosts can reach
```

It is a warning on stderr, not an error — a `source: remote` ship can legitimately
be on this same host behind a tunnel or a published container port, where
`localhost` still resolves. Local ships never trigger it.

The value is used verbatim; it is validated as a non-empty string, not parsed or
normalized like `gui.bridgeUrl`, so write a full URL with its scheme. The
equivalent flag on a standalone bridge is `fleet bridge --public-url`.

It is also what every `source: local` ship is pinned to (`fleet ship
--bridge-url`), so those ships refuse an armory push from anywhere else. A value
that is not an http(s) URL cannot be a pin; rather than fail the launch, it warns
and starts the ships unpinned:

```
fleet launch: bridge.publicUrl "bridge:4800" is not an http(s) URL, so ships are started unpinned and will accept the first armory push they receive
```

Ships registered with `source: remote` are pinned by whatever they were started
with — `fleet launch` does not configure a ship it did not spawn.

### `insecureNoAuth`

A bridge with no users creates the first admin before it serves anything: from
`FLEET_BRIDGE_ADMIN_USER`, `FLEET_BRIDGE_ADMIN_EMAIL` and
`FLEET_BRIDGE_ADMIN_PASSWORD` if all three are set, otherwise by prompting on
stdin. On a headless box with none of them set there is no terminal to answer the
prompt, and the launch fails:

```
fleet launch: fleet-bridge has no users and stdin is not a terminal — set FLEET_BRIDGE_ADMIN_USER, FLEET_BRIDGE_ADMIN_EMAIL, FLEET_BRIDGE_ADMIN_PASSWORD to create the first admin, or start with --insecure-no-auth
```

`insecureNoAuth: true` is how a `fleet launch` config says "this is a dev fleet":
it skips that bootstrap and serves every route as an admin, with a banner on
stderr for as long as the bridge runs. It gives up authentication *and*
authorization — see [authentication](/guides/authentication/) for exactly what.

The `FLEET_INSECURE_NO_AUTH=1` environment variable is **not** consulted by
`fleet launch`; it only affects a standalone `fleet bridge`. Under `fleet launch`
the setting has to be this key.

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
| `shipToken` | string (non-empty) | no | freshly minted | The token this ship presents to the bridge. See [ship credentials](#ship-credentials). |
| `bridgeToken` | string (non-empty) | no | freshly minted | The token the bridge presents to this ship. |

Because `port` defaults to `4700` for every local ship, two or more local ships
must each set a distinct `port`.

### `source: remote`

The ship is already running elsewhere; `fleet launch` only registers it with the
bridge.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `source` | `"remote"` | yes | — | Discriminator. Must be written explicitly; omitting it makes the entry `local`. |
| `url` | string (non-empty) | yes | — | Base URL of the running ship. |
| `shipToken` | string (non-empty) | no | none | The token this ship presents to the bridge. See [ship credentials](#ship-credentials). |
| `bridgeToken` | string (non-empty) | no | none | The token the bridge presents to this ship — the ship's own `FLEET_BRIDGE_TOKEN`. |

Remote entries accept no other fields — no `port`, no `name`, no
`fleetDirectory`. The ship's name is discovered by the bridge from the ship's
own `sync` event, not taken from the map key.

### Ship credentials

`shipToken` and `bridgeToken` are set **together or not at all**, on either kind
of ship. One without the other fails the launch before anything starts:

```
fleet launch: ship "gpu-box" sets shipToken but not bridgeToken; a ship is registered with both a shipToken and a bridgeToken, or neither
```

What each token does, and which end holds it, is covered in
[authentication](/guides/authentication/). What matters here is the default:

- A `source: local` ship with **neither** key set gets a freshly minted pair —
  `fleet launch` generates it, hands it to the ship it spawns, and registers the
  ship with it. That is unchanged behaviour, and the usual case.
- A `source: local` ship with **both** keys set uses those instead of minting.
- A `source: remote` ship with **neither** key set is registered with no
  credentials, and the bridge talks to it unauthenticated.
- A `source: remote` ship with **both** keys set is registered with them. The
  ship itself must already have been started with `FLEET_BRIDGE_TOKEN` set to the
  same `bridgeToken`, or the bridge's very first call to it is rejected and the
  registration fails.

#### `${VAR}` interpolation

Both fields accept `${VAR}` in place of a literal, so the secret never has to be
written into the config file:

```yaml
ships:
  gpu-box:
    source: remote
    url: http://10.0.0.7:4700
    shipToken: ${GPU_BOX_SHIP_TOKEN}
    bridgeToken: ${GPU_BOX_BRIDGE_TOKEN}
```

The rules are deliberately narrow:

| Value | Result |
| --- | --- |
| `${NAME}` — the **whole** value, optionally with surrounding whitespace | Replaced by the environment variable `NAME`, trimmed. |
| any string with no `${` in it | Used literally. |
| anything else containing `${` — `tok-${NAME}`, `${A}${B}` | Rejected. |
| `${NAME}` where `NAME` is unset, empty, or only whitespace | Rejected. |

A variable name must match `[A-Za-z_][A-Za-z0-9_]*`. Interpolation applies only
to these two fields — no other key in the file is expanded.

An unset variable is an error rather than an empty value, and this is the point
of the feature: the alternative is a fleet that comes up looking healthy with a
ship registered unauthenticated, which nothing would tell you about.

```
fleet launch: ships."gpu-box".shipToken is ${GPU_BOX_SHIP_TOKEN}, which is unset or empty in the environment; export GPU_BOX_SHIP_TOKEN, or delete the key to register this ship without credentials
```

A partial interpolation is rejected for the same reason — taking `tok-${NAME}`
literally would register a token that is not the one anybody meant:

```
fleet launch: ships."gpu-box".shipToken contains "${" but is not exactly one ${VAR} reference; write the whole value as ${VAR}, or as the literal secret
```

The resolved value is trimmed, so a variable set from a file or a here-doc with a
trailing newline still works.

## Validation errors

Zod rejects a malformed file before anything starts; the CLI prints
`fleet launch: <message>` and exits 1.

| Error | Raised when |
| --- | --- |
| `config file not found: <path>` | The path given by `--config-path` (or `./fleet-config.yaml`) does not exist. |
| `failed to parse config file <path> as YAML: <message>` | The file is not valid YAML. |
| `ships "<a>" and "<b>" both use port <port>; give each local ship a distinct port` | Two `source: local` ships share a port. Remote ships are exempt — they have no port field. |
| `gui is configured with no bridge to proxy to; add a bridge section or gui.bridgeUrl` | A `gui` section exists with neither a `bridge` section nor `gui.bridgeUrl`. |
| `ships."<key>".<field> is ${VAR}, which is unset or empty in the environment; …` | A `shipToken`/`bridgeToken` references a variable that is not exported, or is empty. |
| `ships."<key>".<field> contains "${" but is not exactly one ${VAR} reference; …` | A `shipToken`/`bridgeToken` mixes literal text with an interpolation. |
| `ship "<key>" sets <a> but not <b>; a ship is registered with both a shipToken and a bridgeToken, or neither` | Exactly one of the two token keys is set on a ship. |
| a zod issue list | Any schema violation: `source: remote` with no `url`; a non-integer `port`; a non-boolean `insecureNoAuth`; an empty `dataDirectory`, `fleetDirectory`, `name`, `url`, `bridgeUrl`, `shipToken`, or `bridgeToken`; a `name` that is not a valid [fleet identifier](/reference/protocol/); an unknown `source` value. |

Ordering matters when reading a failure: schema parsing runs first, then — per
ship, in map order — token interpolation and the both-or-neither check, then the
duplicate-port check, then the gui/bridge check.

## What launch actually does

1. Loads and normalizes the config, resolving every `${VAR}` in a ship's tokens.
2. If `bridge` is present, starts the bridge — creating the first admin unless
   `insecureNoAuth` is set — and keeps its manager.
3. For each ship in map order: settles its credentials (the configured pair if
   both keys are set, otherwise a freshly minted pair for a `source: local` ship
   and none for a `source: remote` one), starts it if `source: local` — pinned to
   the launched bridge's `publicUrl`, and handed that pair — then registers it
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
  publicUrl: http://10.0.0.2:4800
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

`publicUrl` is set here because `builder` is on another host: without it, that
ship would be told to pull the armory from `http://localhost:4800`, which on
`10.0.0.7` is `10.0.0.7`.

A GUI-only process pointed at a bridge on another host:

```yaml
gui:
  port: 3000
  bridgeUrl: http://bridge.internal:4800
```

See [configuring a fleet](/guides/configuring-a-fleet/) for the task-oriented
walkthrough, [multi-host](/guides/multi-host/) for spreading ships across
machines, and [authentication](/guides/authentication/) for what the tokens and
`insecureNoAuth` actually control.
