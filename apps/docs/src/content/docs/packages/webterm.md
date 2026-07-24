---
title: webterm
description: A JSON-over-WebSocket terminal protocol plus the server-side bridge that turns a PTY into streamed grid snapshots.
sidebar:
  order: 5
---

`webterm` carries a live terminal over a WebSocket. Its defining choice is where
the emulation happens: **the server is the terminal emulator**. It spawns a PTY,
parses the raw VT bytes with [`bun-vt`](/packages/bun-vt/), and streams full
cell-grid snapshots to the client. The client only paints cells and sends
keystrokes — it never sees an escape sequence, never tracks cursor state, and
never needs a terminal emulator of its own.

The package has two halves:

- `webterm/protocol` — types, Zod validators, and pure data tables. No PTY, no VT
  emulator, no Bun APIs, so it bundles straight into a browser.
- `webterm` — the above plus `TerminalBridge` and the grid encoder. Server only.

```ts
// browser
import { decodeServerMessage, splitInput } from "webterm/protocol";

// server
import { TerminalBridge, serializeGrid } from "webterm";
```

## The wire protocol

Every frame is a JSON **text** frame. Binary frames are rejected on both sides —
there is a dedicated close code for them.

### Client to server

| Message | Shape | Meaning |
| --- | --- | --- |
| `init` | `{ type: "init", cols, rows }` | First message. Allocate a terminal and spawn the PTY at this size. |
| `input` | `{ type: "input", data }` | Keystrokes or paste bytes to write to the PTY. |
| `resize` | `{ type: "resize", cols, rows }` | Resize both the VT parser and the PTY. |

`cols` must be an integer in `[1, 1024]`, `rows` in `[1, 512]`, and `data` at
most 256 KiB **measured as UTF-8**, not as JavaScript string length. All three
schemas are strict objects: an unknown extra field is a decode failure.

### Server to client

| Message | Shape | Meaning |
| --- | --- | --- |
| `grid` | `{ type: "grid", cols, rows, cursor, cells }` | A full snapshot of the active screen. |
| `exit` | `{ type: "exit", code }` | The shell exited; the connection is closing. |

`cells` is indexed `cells[row][col]` and its dimensions must match `rows` and
`cols` exactly — the decoder cross-checks this, and also that the cursor lies
inside the grid.

Every `grid` message is a **complete** snapshot, never a delta. That makes frame
loss and coalescing trivially safe: if two frames arrive between paints, drawing
only the newest is lossless.

```ts
interface WireCursor {
  x: number;
  y: number;
  visible: boolean;
  shape?: "block" | "underline" | "bar";
  blinking?: boolean;
  color?: WireColor;   // omitted when the cursor uses the terminal default
}
```

## Cell encoding

A terminal screen is mostly blank, so the encoding optimizes hard for that case.
A blank default cell — space, default colors, no styling — serializes as the
literal number `0`. Anything else becomes an object whose fields are present only
when they differ from the default:

```ts
type WireCell = 0 | WireCellObject;

interface WireCellObject {
  t?: string;      // the character; omitted for blanks and spaces, which draw nothing
  f?: WireColor;   // foreground; omitted → terminal default
  b?: WireColor;   // background; omitted → terminal default
  a?: number;      // bitmask of text-decoration flags; omitted → none
  u?: number;      // underline style index 1–5; omitted → none
  w?: number;      // width index 1–3; omitted → narrow
}

type WireColor = number | readonly [number, number, number];
```

A `WireColor` number is a palette index (0–255); a triple is true color; an
absent field means the terminal default. Note that `t` is omitted for a space
even when the cell is styled — a space with a red background still draws its
background, and the client has nothing to paint for the glyph.

The index tables are exported as pure data, so encoder and renderer share one
definition:

```ts
import { ATTR, UNDERLINE, WIDTH } from "webterm/protocol";

ATTR;       // { bold: 1, faint: 2, italic: 4, blink: 8,
            //   inverse: 16, invisible: 32, strikethrough: 64, overline: 128 }
UNDERLINE;  // ["none", "single", "double", "curly", "dotted", "dashed"]
WIDTH;      // ["narrow", "wide", "spacer_tail", "spacer_head"]

const isBold = ((cell.a ?? 0) & ATTR.bold) !== 0;
const underline = UNDERLINE[cell.u ?? 0];
```

Index `0` in `UNDERLINE` and `WIDTH` is the default, which is why those fields
are omitted rather than sent as `0`.

## Limits and close codes

```ts
import {
  MIN_TERMINAL_COLS, MAX_TERMINAL_COLS,   // 1, 1024
  MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS,   // 1, 512
  MAX_INPUT_BYTES,                        // 256 * 1024
  MAX_PENDING_BYTES,                      // 256 * 1024
  MAX_CLIENT_FRAME_BYTES,                 // MAX_INPUT_BYTES * 6 + 128
} from "webterm/protocol";
```

`MAX_CLIENT_FRAME_BYTES` is what a server should set as its WebSocket
`maxPayloadLength`. The ×6 accounts for JSON's worst-case string escaping (a
single byte can become a six-character `\uXXXX` escape), plus a small envelope
allowance. `MAX_PENDING_BYTES` bounds how much client input a proxy may buffer
while its upstream connection is still opening.

Three close reasons are defined so both ends agree on why a socket died:

| Constant | Code | Reason |
| --- | --- | --- |
| `INVALID_MESSAGE_CLOSE_CODE` / `_REASON` | 1008 | `Invalid terminal message` |
| `BINARY_MESSAGE_CLOSE_CODE` / `_REASON` | 1003 | `Binary terminal messages are not supported` |
| `BUFFER_LIMIT_CLOSE_CODE` / `_REASON` | 1009 | `Terminal buffer limit exceeded` |

## Validation and helpers

| Function | Signature | Behavior |
| --- | --- | --- |
| `decodeClientMessage` | `(frame: unknown) => ClientMsg` | Parse and strictly validate a client frame. Throws on anything invalid. |
| `decodeServerMessage` | `(frame: unknown) => ServerMsg` | Same, for server frames. |
| `utf8ByteLength` | `(value: string) => number` | UTF-8 byte length of a string. |
| `clampTerminalSize` | `(cols: number, rows: number) => { cols, rows }` | Truncate and clamp into the legal range; `NaN`/`Infinity` become the minimum. |
| `splitInput` | `(data: string) => string[]` | Split a paste into chunks of at most `MAX_INPUT_BYTES`, never breaking a multi-byte character. |

Both decoders accept either a JSON string or an already-parsed object, and both
reject `ArrayBuffer`/typed-array frames outright with
`terminal frames must be text`.

:::caution
Validate on **both** sides. `decodeClientMessage` is the server's trust boundary,
but a client that renders an unvalidated `grid` message can be handed a cursor
outside the grid or a row of the wrong length. The schema's cross-field checks
exist precisely so the renderer can assume well-formed input.
:::

## The server side

`TerminalBridge` owns one PTY subprocess plus one `bun-vt` terminal. It is
transport-agnostic: it takes a `send` callback and exposes a `handle` method, so
the caller owns the WebSocket.

```ts
new TerminalBridge(options: TerminalBridgeOptions)
```

| Option | Type | Meaning |
| --- | --- | --- |
| `argv` | `string[]` | argv for the PTY process, e.g. `["tmux", "-L", "fleet-ship", "attach", "-t", name]`. |
| `send` | `(msg: ServerMsg) => void` | Sink for server → client messages. |
| `frameIntervalMs` | `number?` | Frame coalescing interval. Defaults to `16` (~60fps). |
| `termName` | `string?` | `TERM` advertised to the child. Defaults to `"xterm-256color"`. |

| Method | Signature | Behavior |
| --- | --- | --- |
| `start` | `(cols: number, rows: number) => void` | Allocate the VT parser and spawn the PTY. Idempotent. |
| `input` | `(data: string) => void` | Write to the PTY. |
| `resize` | `(cols: number, rows: number) => void` | Resize the PTY and the parser, then repaint. |
| `handle` | `(msg: ClientMsg) => void` | Dispatch a decoded client message to the three methods above. |
| `stop` | `() => void` | Kill the PTY and free the parser. Idempotent; does **not** emit `exit`. |

Bytes arriving from the PTY are written into the VT parser and schedule a frame;
the frame timer coalesces a burst of output into one snapshot per interval, so a
process spewing megabytes still produces at most ~60 grid messages a second. When
the child exits, the bridge sends `{ type: "exit", code }` and cleans up.

A minimal server:

```ts
import { TerminalBridge, decodeClientMessage, MAX_CLIENT_FRAME_BYTES } from "webterm";
import {
  BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON,
  INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON,
} from "webterm/protocol";

Bun.serve<{ bridge?: TerminalBridge }>({
  port: 3000,
  fetch(req, server) {
    if (server.upgrade(req, { data: {} })) return;
    return new Response("expected a websocket", { status: 400 });
  },
  websocket: {
    maxPayloadLength: MAX_CLIENT_FRAME_BYTES,

    open(ws) {
      ws.data.bridge = new TerminalBridge({
        argv: ["bash", "-l"],
        send: (msg) => ws.send(JSON.stringify(msg)),
      });
    },

    message(ws, message) {
      if (typeof message !== "string") {
        ws.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
        return;
      }
      try {
        ws.data.bridge?.handle(decodeClientMessage(message));
      } catch {
        ws.close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
      }
    },

    close(ws) {
      ws.data.bridge?.stop();
    },
  },
});
```

`serializeGrid(term: Terminal): GridMsg` and `encodeCell(cell: Cell): WireCell`
are exported separately, so a caller driving `bun-vt` itself can produce the same
snapshots without using `TerminalBridge`.

### How Fleet wires it up

[`fleet-ship`](/concepts/ships/) creates a bridge per terminal connection whose
`argv` attaches to the workspace's tmux session, and adds two policies of its
own on top of the protocol: `init` must be the first message and may not be
repeated (either violation closes with 1008), and an init that never arrives
times out. [`fleet-bridge`](/concepts/bridge/) does not emulate anything — it
decodes and re-serializes each client frame, forwards it to the owning ship, and
buffers up to `MAX_PENDING_BYTES` while the upstream socket is still connecting.
See [Terminals](/concepts/terminals/) for the end-to-end path.

## Driving it from a client

The client's job is small: send `init` once, then `resize` on every size change,
`input` on every keystroke, and repaint on every `grid`.

```ts
import {
  clampTerminalSize,
  decodeServerMessage,
  splitInput,
  BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON,
  INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON,
  type GridMsg,
} from "webterm/protocol";

const ws = new WebSocket(url);
let initialized = false;

function sendSize(cols: number, rows: number) {
  ({ cols, rows } = clampTerminalSize(cols, rows));
  const type = initialized ? "resize" : "init";
  initialized = true;
  ws.send(JSON.stringify({ type, cols, rows }));
}

function sendInput(data: string) {
  // A large paste is split so no single frame exceeds MAX_INPUT_BYTES.
  for (const chunk of splitInput(data)) {
    ws.send(JSON.stringify({ type: "input", data: chunk }));
  }
}

ws.onopen = () => sendSize(80, 24);

ws.onmessage = (event) => {
  if (typeof event.data !== "string") {
    ws.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
    return;
  }
  try {
    const msg = decodeServerMessage(event.data);
    if (msg.type === "grid") paint(msg);
    else console.log("shell exited", msg.code);
  } catch {
    ws.close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
  }
};

function paint(grid: GridMsg) {
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const cell = grid.cells[r]![c]!;
      if (cell === 0) continue;   // blank default cell — nothing to draw
      // draw cell.t with cell.f / cell.b / cell.a …
    }
  }
}
```

Fleet's own consumer is `useWebterm` in `fleet-client`, which follows exactly
this shape and adds the things a real UI needs:

- The first `resize` after the socket opens is sent as `init`; every later one is
  a `resize`. A size reported before the socket is open is buffered and flushed
  on connect.
- Grid frames are deliberately kept **out** of React state. The newest snapshot
  goes into a ref and is painted on the next animation frame — since each frame
  is a full snapshot, dropping intermediate ones is lossless, and a 60fps stream
  never re-renders the component tree.
- The socket is opened only while the terminal is actually visible, and closed on
  unmount — which is what releases the ship's single-terminal guard.

Cell dimensions come from measuring the canvas font, so `cols`/`rows` are derived
from the container size via a `ResizeObserver` and pushed with `resize`.

## Testing

```bash
cd packages/webterm
bun test
```

The suite covers the decoders (dimension boundaries, UTF-8 input measurement,
malformed/unknown/extra-field/scalar/array/binary frames, grid dimension and
cursor cross-checks), the browser helpers (`clampTerminalSize`, `splitInput`
across a multi-byte boundary), and the encoder against a real `bun-vt` terminal —
including that a blank cell serializes to `0` and that the default cursor color
is omitted.
