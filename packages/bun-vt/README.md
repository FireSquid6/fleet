# bun-vt

A **pure-TypeScript** port of [libghostty](https://ghostty.org)'s VT terminal
emulation. Unlike `libghostty-bun` (which binds the Zig/C library over
`bun:ffi`), this package implements everything — the escape-sequence parser, the
screen/grid model, and all terminal semantics — in TypeScript, with no native
code and no build step.

The public `Terminal` API mirrors `libghostty-bun`, so it is a drop-in
replacement:

```ts
import { Terminal } from "bun-vt";

using term = new Terminal({ cols: 80, rows: 24 });
term.write("\x1b[31mhi");          // SGR 31 = red, print "hi"
console.log(term.cell(0, 0).char); // "h"
console.log(term.cell(0, 0).fg);   // { type: "palette", index: 1 }
console.log(term.cursor());        // { x: 2, y: 0, visible: true, pendingWrap: false }
```

## Architecture

| Module            | Responsibility                                                        |
| ----------------- | -------------------------------------------------------------------- |
| `src/parser.ts`   | VT500 (Williams) state machine + UTF-8 decoding → parser actions     |
| `src/screen.ts`   | Grid, cursor, scroll regions, scrollback, alt screen, editing        |
| `src/sgr.ts`      | Select Graphic Rendition (colors + attributes), semicolon & colon    |
| `src/terminal.ts` | Ties parser → screen; implements the public `Terminal` API           |
| `src/cell.ts` / `src/color.ts` / `src/wcwidth.ts` | Cell/color models and display width  |

## What's supported

- Printing with UTF-8 decoding, wide (CJK/emoji) characters and combining marks
- C0 controls (BS, HT, LF/VT/FF, CR), autowrap with pending-wrap semantics
- CSI: cursor moves (CUU/CUD/CUF/CUB/CUP/HVP/CHA/VPA/CNL/CPL), editing
  (ICH/DCH/ECH/IL/DL), erasing (ED/EL), scrolling (SU/SD), tabs (HT/CBT/HTS/TBC),
  scroll regions (DECSTBM), and SGR
- ESC: IND / NEL / RI / HTS / DECSC / DECRC / RIS
- DEC private modes: autowrap (7), origin (6), cursor visibility (25),
  alternate screen (47 / 1047 / 1048 / 1049)
- OSC 0/2 window title; DCS / SOS / PM / APC are parsed and consumed
- Scrollback with a bounded max, and non-reflowing resize

## Develop

```bash
bun install
bun test           # run the full suite
bun run typecheck  # tsc --noEmit
```
