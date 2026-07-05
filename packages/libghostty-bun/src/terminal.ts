/**
 * src/terminal.ts — ergonomic, typed TypeScript wrapper over the raw shim.
 *
 * This is the intended public API. It owns the terminal handle lifecycle and
 * turns the flat FFI cell struct into a well-typed `Cell` object.
 */

import {
  raw,
  CELL,
  CELL_INFO_SIZE,
  GhosttyResult,
  StyleColorTag,
  CellWide,
  type Pointer,
} from "./raw";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A cell foreground/background color. Terminal styles do not always specify a
 * color, hence the `default` variant (meaning "use the terminal default").
 * Palette colors are indices 0–255 (0–15 are the named ANSI colors; index 1 is
 * red). RGB colors are true-color values.
 */
export type Color =
  | { readonly type: "default" }
  | { readonly type: "palette"; readonly index: number }
  | { readonly type: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export type UnderlineStyle =
  | "none"
  | "single"
  | "double"
  | "curly"
  | "dotted"
  | "dashed";

/** Width classification of a cell. */
export type CellWidth = "narrow" | "wide" | "spacer_tail" | "spacer_head";

/** Text-decoration flags of a cell. */
export interface CellStyle {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly faint: boolean;
  readonly blink: boolean;
  readonly inverse: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
  readonly underline: UnderlineStyle;
}

/** A single terminal grid cell snapshot. */
export interface Cell {
  /** The primary character of the cell, or "" if the cell is empty. */
  readonly char: string;
  /** The primary Unicode scalar value, or 0 if the cell is empty. */
  readonly codepoint: number;
  /** Whether the cell has renderable text. */
  readonly hasText: boolean;
  /** Width classification (wide chars occupy two cells). */
  readonly width: CellWidth;
  /** Foreground color. */
  readonly fg: Color;
  /** Background color. */
  readonly bg: Color;
  /** Text-decoration flags. */
  readonly style: CellStyle;
}

/** Cursor position and state. */
export interface CursorState {
  /** Column (0-indexed). */
  readonly x: number;
  /** Row within the active area (0-indexed). */
  readonly y: number;
  /** Whether the cursor is visible (DEC mode 25). */
  readonly visible: boolean;
  /** Whether the next printed character will soft-wrap. */
  readonly pendingWrap: boolean;
}

export interface TerminalOptions {
  /** Terminal width in cells (> 0). */
  readonly cols: number;
  /** Terminal height in cells (> 0). */
  readonly rows: number;
  /** Max scrollback lines to retain. Default 1000. */
  readonly maxScrollback?: number;
}

const UNDERLINE: readonly UnderlineStyle[] = [
  "none",
  "single",
  "double",
  "curly",
  "dotted",
  "dashed",
];

const WIDTH: Record<number, CellWidth> = {
  [CellWide.NARROW]: "narrow",
  [CellWide.WIDE]: "wide",
  [CellWide.SPACER_TAIL]: "spacer_tail",
  [CellWide.SPACER_HEAD]: "spacer_head",
};

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/**
 * A libghostty-vt terminal instance.
 *
 * Lifecycle & ownership:
 *   - The constructor allocates a C-owned terminal handle.
 *   - You MUST call `free()` (or use `using` / `Symbol.dispose`) exactly once to
 *     release it. After `free()`, every method throws.
 *   - No pointer or buffer escapes this object: cell reads copy into a reusable
 *     JS-owned scratch buffer and are fully decoded before the next call, so
 *     there is never a dangling read of freed C memory.
 */
export class Terminal {
  #ptr: Pointer;
  #freed = false;

  // Reusable scratch buffer for cell reads (JS-owned; never handed to C beyond
  // the synchronous fill call).
  readonly #cellBuf = new Uint8Array(CELL_INFO_SIZE);
  readonly #cellView = new DataView(this.#cellBuf.buffer);

  constructor(options: TerminalOptions) {
    const { cols, rows, maxScrollback = 1000 } = options;
    if (!Number.isInteger(cols) || cols <= 0) throw new RangeError(`cols must be a positive integer, got ${cols}`);
    if (!Number.isInteger(rows) || rows <= 0) throw new RangeError(`rows must be a positive integer, got ${rows}`);

    const ptr = raw.gt_terminal_new(cols, rows, BigInt(maxScrollback));
    if (!ptr) throw new Error("ghostty_terminal_new failed (out of memory or invalid args)");
    this.#ptr = ptr;
  }

  #assertAlive(): Pointer {
    if (this.#freed) throw new Error("Terminal has been freed");
    return this.#ptr;
  }

  /** Current width in cells. */
  get cols(): number {
    return raw.gt_cols(this.#assertAlive());
  }

  /** Current height in cells. */
  get rows(): number {
    return raw.gt_rows(this.#assertAlive());
  }

  /**
   * Feed raw VT bytes (or a string, encoded as UTF-8) to the parser, updating
   * terminal state. Never throws on malformed input — the parser is hardened
   * against untrusted data.
   */
  write(data: string | Uint8Array): void {
    const ptr = this.#assertAlive();
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    // `bytes` is borrowed only for the duration of this synchronous call.
    raw.gt_terminal_write(ptr, bytes, BigInt(bytes.byteLength));
  }

  /**
   * Resize the grid. `cellWidthPx`/`cellHeightPx` are the pixel size of a single
   * cell (only used for image/size-report sequences; the defaults are fine for
   * pure text use).
   */
  resize(cols: number, rows: number, cellWidthPx = 1, cellHeightPx = 1): void {
    const ptr = this.#assertAlive();
    if (!Number.isInteger(cols) || cols <= 0) throw new RangeError(`cols must be a positive integer, got ${cols}`);
    if (!Number.isInteger(rows) || rows <= 0) throw new RangeError(`rows must be a positive integer, got ${rows}`);
    const rc = raw.gt_terminal_resize(ptr, cols, rows, cellWidthPx, cellHeightPx);
    if (rc !== GhosttyResult.SUCCESS) throw new Error(`resize failed: GhosttyResult ${rc}`);
  }

  /** Perform a full reset (RIS). Dimensions are preserved. */
  reset(): void {
    raw.gt_terminal_reset(this.#assertAlive());
  }

  /**
   * Read the cell at (row, col) in the active area. Both are 0-indexed.
   * Throws RangeError if the coordinate is out of bounds.
   */
  cell(row: number, col: number): Cell {
    const ptr = this.#assertAlive();
    // gt_read_cell(term, x=col, y=row, out*). The out buffer is JS-owned and
    // fully decoded before we return; nothing dangles.
    const rc = raw.gt_read_cell(ptr, col, row, this.#cellBuf);
    if (rc !== GhosttyResult.SUCCESS) {
      throw new RangeError(`cell(${row}, ${col}) out of bounds (GhosttyResult ${rc})`);
    }
    return this.#decodeCell();
  }

  /** Read the current cursor position and state. */
  cursor(): CursorState {
    const ptr = this.#assertAlive();
    return {
      x: raw.gt_cursor_x(ptr),
      y: raw.gt_cursor_y(ptr),
      visible: raw.gt_cursor_visible(ptr) !== 0,
      pendingWrap: raw.gt_cursor_pending_wrap(ptr) !== 0,
    };
  }

  /**
   * Convenience: read an entire row as a string (primary codepoints only,
   * trailing empty cells trimmed).
   */
  rowText(row: number): string {
    const width = this.cols;
    let out = "";
    for (let col = 0; col < width; col++) {
      const cp = this.cell(row, col).codepoint;
      out += cp === 0 ? " " : String.fromCodePoint(cp);
    }
    return out.replace(/\s+$/u, "");
  }

  /**
   * Release the underlying C terminal handle. Idempotent. After this, all other
   * methods throw. Pairs 1:1 with construction.
   */
  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    raw.gt_terminal_free(this.#ptr);
  }

  /** Enables `using term = new Terminal(...)`. */
  [Symbol.dispose](): void {
    this.free();
  }

  // -- internal ------------------------------------------------------------

  #decodeCell(): Cell {
    const v = this.#cellView;
    const codepoint = v.getUint32(CELL.codepoint, true);
    return {
      codepoint,
      char: codepoint === 0 ? "" : String.fromCodePoint(codepoint),
      hasText: v.getUint8(CELL.has_text) !== 0,
      width: WIDTH[v.getUint8(CELL.wide)] ?? "narrow",
      fg: decodeColor(
        v.getUint8(CELL.fg_tag),
        v.getUint8(CELL.fg_palette),
        v.getUint8(CELL.fg_r),
        v.getUint8(CELL.fg_g),
        v.getUint8(CELL.fg_b),
      ),
      bg: decodeColor(
        v.getUint8(CELL.bg_tag),
        v.getUint8(CELL.bg_palette),
        v.getUint8(CELL.bg_r),
        v.getUint8(CELL.bg_g),
        v.getUint8(CELL.bg_b),
      ),
      style: {
        bold: v.getUint8(CELL.bold) !== 0,
        italic: v.getUint8(CELL.italic) !== 0,
        faint: v.getUint8(CELL.faint) !== 0,
        blink: v.getUint8(CELL.blink) !== 0,
        inverse: v.getUint8(CELL.inverse) !== 0,
        invisible: v.getUint8(CELL.invisible) !== 0,
        strikethrough: v.getUint8(CELL.strikethrough) !== 0,
        overline: v.getUint8(CELL.overline) !== 0,
        underline: UNDERLINE[v.getUint8(CELL.underline)] ?? "none",
      },
    };
  }
}

function decodeColor(tag: number, palette: number, r: number, g: number, b: number): Color {
  switch (tag) {
    case StyleColorTag.PALETTE:
      return { type: "palette", index: palette };
    case StyleColorTag.RGB:
      return { type: "rgb", r, g, b };
    default:
      return { type: "default" };
  }
}
