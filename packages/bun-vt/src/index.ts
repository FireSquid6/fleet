/**
 * bun-vt — a pure-TypeScript port of libghostty's VT terminal emulation.
 *
 * No native code, no FFI: the VT500 parser, the screen/grid model, and all
 * escape-sequence semantics are implemented in TypeScript. The public API
 * mirrors libghostty-bun's `Terminal`, so it is a drop-in replacement:
 *
 * ```ts
 * import { Terminal } from "bun-vt";
 *
 * using term = new Terminal({ cols: 80, rows: 24 });
 * term.write("\x1b[31mhi");
 * console.log(term.cell(0, 0).char); // "h"
 * ```
 */

export {
  Terminal,
  type Cell,
  type CellStyle,
  type CellWidth,
  type Color,
  type CursorState,
  type TerminalOptions,
  type UnderlineStyle,
} from "./terminal";

// Lower-level building blocks, for advanced use / testing.
export { Parser, type Handler, type CsiSequence, type EscSequence } from "./parser";
export { Screen } from "./screen";
export { wcwidth } from "./wcwidth";
export {
  type Color as ColorValue,
  DEFAULT_COLOR,
  DEFAULT_PALETTE,
  NamedColor,
  palette,
  rgb,
  colorsEqual,
} from "./color";
