/**
 * libghostty-bun — bun:ffi bindings for libghostty-vt.
 *
 * Public entrypoint. Import the ergonomic API from here:
 *
 * ```ts
 * import { Terminal } from "libghostty-bun";
 *
 * using term = new Terminal({ cols: 80, rows: 24 });
 * term.write("\x1b[31mhi");
 * console.log(term.cell(0, 0).char); // "h"
 * ```
 *
 * The pinned ghostty commit and low-level symbol table are re-exported for
 * advanced use.
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

export { PINNED_COMMIT } from "./raw";

// Escape hatch: the raw symbol table and result-code constants.
export { raw, closeLibrary, SHIM_PATH, GhosttyResult } from "./raw";
