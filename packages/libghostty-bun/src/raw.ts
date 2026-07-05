/**
 * src/raw.ts — low-level bindings: raw dlopen + symbol table.
 *
 * This module dlopen()s the compiled C shim (prebuilds/ghostty_vt_shim.<suffix>)
 * and exposes the raw FFI symbols with no ergonomics on top. Everything here
 * deals in raw pointers, integers and byte buffers. The typed, safe API lives
 * in src/terminal.ts.
 *
 * The shim is a thin flattening layer over libghostty-vt's C API (see
 * shim/ghostty_vt_shim.h for the rationale — libghostty-vt passes some structs
 * by value, which bun:ffi cannot bind directly).
 *
 * Ownership (mirrors the shim header):
 *   - `gt_terminal_new` returns an OWNED handle → must be passed to
 *     `gt_terminal_free` exactly once.
 *   - Byte buffers passed to `gt_terminal_write` / `gt_read_cell` are borrowed
 *     for the duration of the call only and remain owned by the caller (JS GC).
 *   - `gt_type_json` returns a pointer to a process-lifetime static string that
 *     must NOT be freed.
 */

import { dlopen, FFIType, suffix, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Absolute path to the compiled shim shared library. */
export const SHIM_PATH = join(HERE, "..", "prebuilds", `ghostty_vt_shim.${suffix}`);

if (!existsSync(SHIM_PATH)) {
  throw new Error(
    `libghostty-vt shim not found at ${SHIM_PATH}\n` +
      `Build it first with:  bun run scripts/build.ts`,
  );
}

const { symbols, close } = dlopen(SHIM_PATH, {
  // ---- lifecycle ----
  gt_terminal_new: {
    args: [FFIType.u16, FFIType.u16, FFIType.u64], // cols, rows, max_scrollback
    returns: FFIType.ptr, // owned GtTerminal, or NULL on failure
  },
  gt_terminal_free: { args: [FFIType.ptr], returns: FFIType.void },
  gt_terminal_reset: { args: [FFIType.ptr], returns: FFIType.void },

  // ---- mutation ----
  gt_terminal_write: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64], // term, data, len
    returns: FFIType.void,
  },
  gt_terminal_resize: {
    args: [FFIType.ptr, FFIType.u16, FFIType.u16, FFIType.u32, FFIType.u32],
    returns: FFIType.i32, // GhosttyResult
  },

  // ---- scalar reads ----
  gt_cols: { args: [FFIType.ptr], returns: FFIType.u16 },
  gt_rows: { args: [FFIType.ptr], returns: FFIType.u16 },
  gt_cursor_x: { args: [FFIType.ptr], returns: FFIType.u16 },
  gt_cursor_y: { args: [FFIType.ptr], returns: FFIType.u16 },
  gt_cursor_visible: { args: [FFIType.ptr], returns: FFIType.i32 },
  gt_cursor_pending_wrap: { args: [FFIType.ptr], returns: FFIType.i32 },

  // ---- cell read ----
  gt_read_cell: {
    args: [FFIType.ptr, FFIType.u16, FFIType.u32, FFIType.ptr], // term, x, y, out*
    returns: FFIType.i32, // GhosttyResult
  },

  // ---- build info ----
  gt_type_json: { args: [], returns: FFIType.cstring },
});

export const raw = symbols;
export { close as closeLibrary };
export type { Pointer };

/**
 * Byte layout of the shim's flat `GtCellInfo` struct (32 bytes).
 * MUST stay in sync with shim/ghostty_vt_shim.h. The `_Static_assert` in the
 * shim guards the total size; these offsets mirror the field positions.
 */
export const CELL_INFO_SIZE = 32;
export const CELL = {
  codepoint: 0, // u32
  has_text: 4, // u8
  wide: 5, // u8
  content_tag: 6, // u8
  fg_tag: 8, // u8
  fg_palette: 9, // u8
  fg_r: 10, // u8
  fg_g: 11, // u8
  fg_b: 12, // u8
  bg_tag: 13, // u8
  bg_palette: 14, // u8
  bg_r: 15, // u8
  bg_g: 16, // u8
  bg_b: 17, // u8
  bold: 18, // u8
  italic: 19, // u8
  faint: 20, // u8
  blink: 21, // u8
  inverse: 22, // u8
  invisible: 23, // u8
  strikethrough: 24, // u8
  overline: 25, // u8
  underline: 26, // u8
} as const;

/**
 * libghostty-vt result codes (GhosttyResult). 0 == success.
 * Mirrors include/ghostty/vt/types.h.
 */
export const GhosttyResult = {
  SUCCESS: 0,
  OUT_OF_MEMORY: -1,
  INVALID_VALUE: -2,
  OUT_OF_SPACE: -3,
  NO_VALUE: -4,
} as const;

/** GhosttyStyleColorTag (include/ghostty/vt/style.h). */
export const StyleColorTag = {
  NONE: 0,
  PALETTE: 1,
  RGB: 2,
} as const;

/** GhosttyCellWide (include/ghostty/vt/screen.h). */
export const CellWide = {
  NARROW: 0,
  WIDE: 1,
  SPACER_TAIL: 2,
  SPACER_HEAD: 3,
} as const;

/** The exact ghostty commit this shim/binding was built against. */
export const PINNED_COMMIT = "8642142a3d62beda7b1a9733c23bf11b80c720eb";
