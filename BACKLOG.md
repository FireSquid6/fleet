# Backlog

## Event stream snapshot sizing

The client WebSocket proxy currently applies the 256 KiB `MAX_PENDING_BYTES`
limit to upstream frames received before the browser-facing socket opens. The
bridge sends the complete fleet snapshot as one frame, and agent status strings
are not bounded, so a valid snapshot can exceed this limit and cause a permanent
reconnect loop.

- Define event-stream frame and buffer limits separately from terminal limits.
- Bound agent status field sizes at the protocol/API boundary.
- Chunk or paginate snapshots if the supported fleet size can exceed one frame.
- Add coverage for snapshots near and above the supported limit.

## Copy out of the web terminal

Issue #9 is titled "Fix copy and paste", but only paste was fixed. The canvas
renderer has no selection model, so there is no way to get text out of a web
terminal at all — no drag-select, no keyboard selection, no context menu.
`Ctrl+Shift+C` is now merely inert (it used to encode `\x03` and interrupt the
running process), which stops the chord being destructive but does not make it
copy.

- Add a selection model over the grid: pointer drag to select, painted as an
  inverted or tinted range, cleared on new output or Escape.
- Turn a selection into text. The client already holds the newest snapshot in
  `latestGrid.current`, and `bun-vt` has `rowText`, so a screen or region copy
  needs no new protocol message.
- Wire `Ctrl+Shift+C` (and `Cmd+C`) to `navigator.clipboard.writeText`, keeping
  the encoder's `null` return so the chord still reaches the handler.
- Decide the no-selection behavior: real terminals fall back to copying nothing
  rather than to SIGINT.
- Verify that Chrome and Firefox dispatch a native `paste` event to a
  **non-editable** focusable `<div>` for `Ctrl+Shift+V`. This was never confirmed
  in a real browser; if they do not, the chord is a silent no-op today and the
  remedy is xterm.js's approach — an offscreen editable textarea as the key and
  clipboard sink, which would also give selection a home.

## Paste in `fleet client attach`

The web client now sends pastes as a distinct `paste` message that the ship
brackets, but the CLI's `attach` forwards raw stdin as `input` and never enables
DECSET 2004 on its own stdout. It therefore cannot distinguish a paste from
typing, so a multi-line clipboard still arrives as a line-by-line submit — the
exact failure bracketed paste exists to prevent, still live on that client.

- Advertise mode 2004 on the CLI's own terminal and handle the local emulator's
  `ESC [ 200~` / `ESC [ 201~` framing.
- Scan for those markers across stdin chunk boundaries: a read can split a marker,
  so the scanner has to be stateful.
- Forward the framed text as `paste` and leave everything else as `input`.

## No protocol version negotiation

Nothing on the wire carries a protocol version. Both proxies and the ship validate
every frame with `decodeClientMessage` and close with 1008 on failure, so adding a
client→server message type is a breaking change: a new web client talking to a
ship that has not been updated kills the terminal socket on the user's first
paste. The tmux session survives, so the blast radius is one reconnect rather than
lost work, but the failure is opaque to the user and scales with fleet
heterogeneity.

- Carry a protocol version (or a capability list) on the terminal upgrade, and
  have the ship report what it understands.
- Let a client degrade instead of breaking — fall back to `input` for a paste when
  the peer does not know `paste`.
- Prefer ignoring an unknown-but-well-formed client message over closing 1008, so
  a forward-compatible addition is not fatal.

## Bridge event backpressure

The bridge broadcasts events without checking `ServerWebSocket.send()` results
or configuring backpressure behavior. A slow browser can miss an update while
remaining connected, leaving its workspace state stale because a fresh snapshot
is only sent after reconnecting.

- Handle dropped and backpressured sends explicitly.
- Close affected clients so reconnect synchronization repairs their state, or
  implement bounded per-client queues with `drain` handling.
- Configure explicit WebSocket backpressure limits.
- Add slow-client and backpressure regression coverage.
