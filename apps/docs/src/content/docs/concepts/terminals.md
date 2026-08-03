---
title: Terminals
description: How a workspace gets a live terminal, from headless tmux to a grid painted in the browser.
sidebar:
  order: 6
---

Every active workspace has a live terminal you can attach to from the browser.
The chain is three pieces:

```
tmux session  ──PTY──▶  bun-vt (VT emulator)  ──JSON grid frames──▶  browser
   on the ship            on the ship                                  paints
```

The unusual part is where the terminal emulation happens: **on the server**. The
browser is not running a terminal emulator. It receives a grid of cells and
draws it.

## The session is tmux, not a shell

Activating a workspace creates a *headless* tmux session rooted at the workspace
directory. Fleet drives tmux through [`tmux-bun`](/packages/tmux-bun/), which
wraps the tmux CLI and deliberately exposes no `attach` — every operation is a
one-shot invocation against an isolated tmux server.

Fleet's server is the namespace `fleet-ship`, i.e. everything runs under
`tmux -L fleet-ship`. That keeps Fleet's sessions out of your personal tmux
server entirely.

Session names are derived, not chosen. A workspace's session name is
`ws-<sha256 hex>`, hashed over a version byte plus the length-prefixed repo and
workspace names. Length-prefixing means no pair of names can collide by
concatenation, and hashing means arbitrary (valid) identifiers survive tmux's
own naming restrictions. The derivation is deterministic, so the ship can ask
"is this workspace active?" with a single `has-session` call and no bookkeeping.

Two consequences fall out of using tmux for this:

- **The session outlives the socket.** Closing the browser tab, losing the
  network, or restarting the bridge does not kill what the agent is running. Only
  deactivating the workspace does.
- **You can attach by hand.** From a shell on the ship:

  ```bash
  tmux -L fleet-ship ls
  tmux -L fleet-ship attach -t ws-<hash>
  ```

## The webterm protocol

`WS /workspaces/:repo/:name/terminal` speaks
[`webterm`](/packages/webterm/) — a small JSON-over-WebSocket contract. All
frames are text; a binary frame closes the connection.

**Client → server**

| Message | Payload | Meaning |
|---|---|---|
| `init` | `cols`, `rows` | first message: allocate the emulator and spawn the PTY at this size |
| `input` | `data` | keystrokes or pasted bytes to write to the PTY |
| `resize` | `cols`, `rows` | resize both the PTY and the emulator |
| `ack` | `seq` | this frame arrived and was painted |
| `resync` | — | the frame sequence broke; send a full snapshot |

**Server → client**

| Message | Payload | Meaning |
|---|---|---|
| `grid` | `seq`, `cols`, `rows`, `cursor`, `cells` | a full snapshot of the active screen |
| `patch` | `seq`, `cols`, `rows`, `cursor`, `runs` | the cells that changed since frame `seq - 1` |
| `exit` | `code` | the process exited; the connection is closing |

`init` must be the first message and must be sent exactly once — sending it
twice, or sending anything else first, closes the socket. If it doesn't arrive
within five seconds the ship closes the connection with `1008 terminal init
timeout`, so an idle socket can't hold a workspace's terminal slot open.

Sizes are bounded (1–1024 columns, 1–512 rows) and a single `input` is capped at
256 KiB, which the client-side helper handles by splitting large pastes into
chunks on UTF-8 character boundaries.

### Frames are cells, not escape sequences

There is no scrollback protocol and no escape sequences on the wire. When the PTY
produces output, the ship feeds the raw bytes to [`bun-vt`](/packages/bun-vt/) —
a pure-TypeScript port of libghostty's VT emulation — and schedules a frame.
Frames are coalesced at roughly 16 ms (~60 fps), so a burst of output produces
one frame rather than thousands, and an interval in which nothing changed
produces none at all.

Two frame types carry the screen. A `grid` is a **complete** snapshot: it can be
applied to any state, which makes it self-syncing. A `patch` carries only the
runs of cells that changed, and is valid only against the frame numbered
`seq - 1`. A connection opens with a `grid`, and so does the first frame after a
resize — a patch cannot cross a size change — or after a client asks to `resync`.
Everything else is a patch.

That is safe alongside the coalescing above because the diff baseline is the last
frame the ship actually **sent**, not the last one it computed. Frames the ship
chose to skip are simply folded into the next patch.

Skipping is the other half of the design. The client acks every frame it paints,
and the ship stops producing once too many frames are unacked, so a slow link
makes the terminal coarser rather than putting it further and further behind.
Every WebSocket in the chain also negotiates permessage-deflate, which these
frames — repetitive JSON, mostly blank cells — compress extremely well.

To keep frames small in the first place, cells use a compact encoding: a blank
default cell — a space, default colors, no styling, which is most of a screen —
serializes as the literal number `0`. Anything else is an object carrying only
its non-default fields: character, foreground, background, an attribute bitmask,
underline style, and cell width.

The upshot is that the browser side stays simple: decode, fold the frame into
the current snapshot with the shared `GridStream` helper, paint cells to a
canvas, encode key events back. The [webterm reference](/packages/webterm/) has
the full table of attribute bits and color forms.

### One terminal per workspace

A ship allows a single terminal connection per workspace session. Two browser
tabs racing to attach the same tmux session through separate PTYs would fight
over the same screen, so the second connection is told `{"type":"exit","code":1}`
and closed immediately.

The guard is released when the socket closes — including when an intermediate
proxy closes it — so a dropped tab frees the slot without manual cleanup.

## The path through the proxies

In a browser, a terminal frame crosses three sockets:

```
browser ──▶ fleet-client server ──▶ bridge ──▶ ship ──▶ PTY
```

Each hop is a dumb bidirectional pipe with the same three jobs: reject binary
frames, validate that text frames decode as protocol messages, and buffer the
browser's frames until its upstream socket is open — otherwise the very first
`init` would be lost to a race and the terminal would never start. Buffers are
bounded at 256 KiB; exceeding that closes the connection with `1009`.

The bridge resolves the target by looking up the owning ship in its
[ownership index](/concepts/bridge/); if the workspace is unknown or its ship is
offline, it uses the protocol's own failure convention — `exit` with code `1`,
then close — because there is no HTTP status available once a WebSocket is open.

## In the GUI

The React hook opens the socket only while the workspace is active and tears it
down when the component unmounts, which releases the ship's single-terminal
guard. It measures the rendered grid and reports the size: the first report
after the socket opens is the `init` that spawns the attach, and every later one
is a `resize`. Grid frames are handed straight to an imperative canvas painter
rather than through React state, so 60 fps of output doesn't re-render the app.

See the [web GUI guide](/guides/web-gui/).
