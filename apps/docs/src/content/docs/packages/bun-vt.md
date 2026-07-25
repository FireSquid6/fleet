---
title: bun-vt
description: A pure-TypeScript VT terminal emulator — escape-sequence parser plus screen model, with no native code and no FFI.
sidebar:
  order: 4
---

`bun-vt` is a pure-TypeScript port of [libghostty](https://ghostty.org)'s VT
terminal emulation. The escape-sequence parser, the screen/grid model, and all
terminal semantics are implemented in TypeScript — no native code, no `bun:ffi`,
no build step.

You feed it the raw bytes a shell writes to a PTY; it gives you back a cell grid
you can render however you like. In Fleet, [`webterm`](/packages/webterm/) runs
it server-side and streams the resulting grid to the browser, which is why the
browser never has to parse an escape sequence.

```ts
import { Terminal } from "bun-vt";

using term = new Terminal({ cols: 80, rows: 24 });
term.write("\x1b[31mhi");

term.cell(0, 0).char;   // "h"
term.cell(0, 0).fg;     // { type: "palette", index: 1 }
term.rowText(0);        // "hi"
term.cursor().x;        // 2
```

## The Terminal API

```ts
new Terminal(options: TerminalOptions)
```

`TerminalOptions` is `{ cols, rows, maxScrollback? }`. `cols` and `rows` must be
positive integers or the constructor throws a `RangeError`; `maxScrollback`
defaults to `1000` lines.

| Member | Signature | Behavior |
| --- | --- | --- |
| `cols` / `rows` | `number` (getters) | Current dimensions. |
| `title` | `string` | Last window/icon title set via OSC 0/2. Informational. |
| `write` | `(data: string \| Uint8Array) => void` | Feed raw VT bytes (strings are UTF-8 encoded first). Never throws on malformed input. |
| `resize` | `(cols: number, rows: number, cellWidthPx?, cellHeightPx?) => void` | Resize the grid. The pixel arguments exist for API compatibility and are ignored. |
| `reset` | `() => void` | Full reset (RIS). Dimensions are preserved. |
| `cell` | `(row: number, col: number) => Cell` | Read one cell of the active area. Throws `RangeError` when out of bounds. |
| `cursor` | `() => CursorState` | Position and appearance. |
| `rowText` | `(row: number) => string` | A whole row as text: primary codepoints, wide-char tail spacers skipped, trailing whitespace trimmed. |
| `free` | `() => void` | Release the terminal. Every method afterwards throws `"Terminal has been freed"`. |
| `[Symbol.dispose]` | `() => void` | Calls `free`, so `using term = new Terminal(...)` works. |

Note the argument order of `cell(row, col)` — row first, matching the grid's
own indexing, not `(x, y)`.

### CursorState

```ts
const cursor = term.cursor();
// { x, y, visible, pendingWrap, shape, blinking, color }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `x`, `y` | `number` | 0-indexed column and row. |
| `visible` | `boolean` | DECTCEM (mode 25). |
| `pendingWrap` | `boolean` | Set after writing the last column; the next print wraps first. |
| `shape` | `"block" \| "underline" \| "bar"` | From DECSCUSR (`CSI SP q`). |
| `blinking` | `boolean` | Also from DECSCUSR. |
| `color` | `Color` | From OSC 12; reset to default by OSC 112. |

### Cell

```ts
interface Cell {
  char: string;        // primary character, or "" when the cell is empty
  codepoint: number;   // primary scalar value, or 0
  hasText: boolean;
  width: "narrow" | "wide" | "spacer_tail" | "spacer_head";
  fg: Color;
  bg: Color;
  style: CellStyle;
}
```

`CellStyle` is `{ bold, italic, faint, blink, inverse, invisible, strikethrough,
overline, underline }`, where `underline` is a `UnderlineStyle` —
`"none" | "single" | "double" | "curly" | "dotted" | "dashed"`.

A wide (CJK/emoji) glyph occupies two cells: the head carries the codepoint with
`width: "wide"`, and the following cell is a `"spacer_tail"` with no codepoint.

### Color

Colors are a tagged union, kept symbolic rather than resolved to RGB:

```ts
type Color =
  | { type: "default" }
  | { type: "palette"; index: number }   // 0–255
  | { type: "rgb"; r: number; g: number; b: number };
```

SGR 30–37 / 40–47 / 90–97 / 100–107 select **palette** colors, not RGB, so
`\x1b[31m` yields `{ type: "palette", index: 1 }` — matching Ghostty. To resolve
an index to concrete RGB, use the exported default palette:

```ts
import { DEFAULT_PALETTE, NamedColor, palette, rgb, colorsEqual } from "bun-vt";

DEFAULT_PALETTE[NamedColor.RED];   // [0x80, 0x00, 0x00]
palette(1);                        // { type: "palette", index: 1 }
rgb(0x12, 0x34, 0x56);             // { type: "rgb", r: 18, g: 52, b: 86 }
colorsEqual(palette(1), palette(1)); // true
```

`DEFAULT_PALETTE` is the xterm default: indices 0–15 the named ANSI colors,
16–231 the 6×6×6 color cube, 232–255 the grayscale ramp.

## Module architecture

| Module | Responsibility |
| --- | --- |
| `src/parser.ts` | VT500 (Williams) state machine plus UTF-8 decoding. A pure byte → action translator that never touches terminal state. |
| `src/screen.ts` | The grid: cursor, scroll region, scrollback, tab stops, alternate screen, and every editing primitive. |
| `src/sgr.ts` | Select Graphic Rendition — colors and attributes, semicolon and colon forms. |
| `src/terminal.ts` | Ties parser to screen; implements the parser's `Handler` and the public `Terminal` API. |
| `src/cell.ts` | The `Cell` snapshot and the mutable `Pen` the grid stores per cell. |
| `src/color.ts` | The color union and the default 256-color palette. |
| `src/wcwidth.ts` | Display width of a scalar value: 0, 1, or 2 cells. |

The split mirrors libghostty's own: the parser is a SAX-style callback machine,
and every terminal semantic lives in the handler. `Terminal` *is* the handler —
it implements `print`, `execute`, `csiDispatch`, `escDispatch`, and
`oscDispatch`, translating each into `Screen` mutations.

The lower-level pieces are exported for advanced use and testing:

```ts
import { Parser, Screen, wcwidth, type Handler, type CsiSequence } from "bun-vt";

const handler: Handler = {
  print: (cp) => console.log("print", String.fromCodePoint(cp)),
  execute: (c) => console.log("control", c),
  csiDispatch: (seq) => console.log("CSI", seq.prefix, seq.params, seq.final),
  escDispatch: (seq) => console.log("ESC", seq.final),
  oscDispatch: (data) => console.log("OSC", data),
};

const parser = new Parser(handler);
parser.write(new TextEncoder().encode("\x1b[1;31mred\r\n"));
```

`CsiSequence` carries `{ params, colon, intermediates, prefix, final }`. The
`colon` array is the piece most parsers omit: `colon[i]` is `true` when
`params[i]` was separated from its predecessor by a colon rather than a
semicolon, which is what makes ISO 8613-6 forms like `4:3` and `38:2::r:g:b`
decodable. `Handler.dcsHook`, `dcsPut`, and `dcsUnhook` are optional.

## What is supported

**Printing.** UTF-8 decoding in the ground state, wide (CJK/emoji) characters
placed as head + tail spacer, and autowrap with correct pending-wrap semantics.
Zero-width combining marks are consumed without moving the cursor — the cell
model stores a single scalar per cell, so the base character is kept and the mark
itself is dropped.

**C0 controls.** BS, HT, LF/VT/FF, CR. BEL and SO/SI are consumed as no-ops
(charset shifting is not modelled). DEL is ignored on print.

**CSI sequences.**

| Group | Sequences |
| --- | --- |
| Cursor motion | CUU `A`, CUD `B`, CUF `C`, CUB `D`, CNL `E`, CPL `F`, CHA `G` / HPA `` ` ``, VPA `d`, CUP `H`, HVP `f` |
| Editing | ICH `@`, DCH `P`, ECH `X`, IL `L`, DL `M` |
| Erasing | ED `J` (modes 0/1/2/3 — mode 3 also clears scrollback), EL `K` (modes 0/1/2) |
| Scrolling | SU `S`, SD `T`, DECSTBM `r` |
| Tabs | CBT `Z`, TBC `g` |
| Saved cursor | SCP `s`, RCP `u` |
| Rendition | SGR `m` |
| Cursor style | DECSCUSR `CSI SP q` (styles 0–6) |

Other CSI prefixes (`<`, `=`, `>`) are parsed and ignored.

**ESC sequences.** IND `D`, NEL `E`, RI `M`, HTS `H`, DECSC `7`, DECRC `8`, RIS
`c`. Charset designators (`ESC ( B` and friends) are parsed and ignored.

**DEC private modes** (`CSI ? … h` / `l`):

| Mode | Meaning |
| --- | --- |
| 6 | DECOM — origin mode |
| 7 | DECAWM — autowrap |
| 25 | DECTCEM — cursor visibility |
| 47 / 1047 | Alternate screen |
| 1048 | Save/restore cursor |
| 1049 | Alternate screen with save/restore and clear |

**SGR.** Bold, faint, italic, blink, inverse, invisible, strikethrough,
overline, and underline styles (including `4:n` for curly/dotted/dashed and code
21 for double). Extended colors in both the semicolon form (`38;5;n`,
`38;2;r;g;b`) and the colon form (`38:5:n`, `38:2::r:g:b`, where the leading
colorspace field is ignored). Code 58 (underline color) is parsed and its
parameters consumed, but the value is not stored.

**OSC.** 0 and 2 set `term.title`; 12 sets the cursor color (accepting both
`#rrggbb` and X11 `rgb:r/g/b` with 1–4 hex digits per component); 112 resets it.
Other OSC codes are parsed and ignored. DCS, SOS, PM, and APC strings are parsed
and consumed.

**Scrollback and resize.** Lines that scroll off the top of a full-height,
non-alternate screen enter a bounded scrollback. Resize does not reflow: rows are
padded or truncated in place, extra bottom rows are added blank, and surplus rows
from the top are pushed into scrollback so on-screen content near the top is
preserved.

**Background-color erase.** A cell blanked by an erase keeps the pen's current
background color, matching xterm and Ghostty.

## Robustness

The parser is hardened against arbitrary input: every byte has a defined
transition, nothing throws, and parameter/intermediate/OSC accumulators are all
bounded (32 params, 16 intermediate bytes, 4 KiB of OSC payload; individual
parameters clamp at 65535, matching xterm). Malformed UTF-8, isolated
continuation bytes, surrogates, and out-of-range scalars all become U+FFFD.

This matters because the byte stream comes from a subprocess: `write` is the
untrusted boundary, and it is designed never to fail on what it is given.

## Testing

```bash
cd packages/bun-vt
bun test
```

The suite covers the parser state machine, cursor motion, scrolling, SGR
(including colon sub-parameters), DEC modes, Unicode width handling, and an
acceptance pass over realistic byte streams.
