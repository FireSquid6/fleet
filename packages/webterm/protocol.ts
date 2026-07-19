/**
 * webterm/protocol.ts — the JSON-over-WebSocket contract between the browser and
 * the Bun server. Both sides import from this file. It contains only type
 * definitions plus a few pure data tables (no PTY / no VT emulator), so it is
 * safe to bundle straight into the browser.
 *
 * The server is the terminal emulator: it parses the shell's raw VT bytes with
 * bun-vt into a cell grid and streams full grid snapshots to the client.
 * The client only paints cells and sends keystrokes.
 */

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** First message: allocate a Terminal and spawn the shell at this size. */
export interface InitMsg {
  readonly type: "init";
  readonly cols: number;
  readonly rows: number;
}

/** Keystrokes / paste bytes to write to the PTY. */
export interface InputMsg {
  readonly type: "input";
  readonly data: string;
}

/** Resize both the VT parser and the PTY. */
export interface ResizeMsg {
  readonly type: "resize";
  readonly cols: number;
  readonly rows: number;
}

export type ClientMsg = InitMsg | InputMsg | ResizeMsg;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Cursor position + visibility within the active screen. */
export interface WireCursor {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
}

/** A full active-screen snapshot to paint. `cells` is indexed `cells[row][col]`. */
export interface GridMsg {
  readonly type: "grid";
  readonly cols: number;
  readonly rows: number;
  readonly cursor: WireCursor;
  readonly cells: WireCell[][];
}

/** Shell exited; the connection is closing. */
export interface ExitMsg {
  readonly type: "exit";
  readonly code: number;
}

export type ServerMsg = GridMsg | ExitMsg;

// ---------------------------------------------------------------------------
// Compact cell encoding
// ---------------------------------------------------------------------------

/**
 * A cell color.
 * - omitted (the field absent on the cell) → terminal default
 * - `number` → palette index (0–255)
 * - `[r, g, b]` → true color
 */
export type WireColor = number | readonly [number, number, number];

/**
 * A non-blank cell. Only non-default fields are present:
 * - `t` the character (omitted for blanks/spaces, which draw nothing)
 * - `f` foreground color   (omitted → terminal default)
 * - `b` background color   (omitted → terminal default)
 * - `a` bitmask of text-decoration flags (omitted → none)
 * - `u` underline style index 1–5 (omitted → none)
 * - `w` width index 1–3 (omitted → narrow)
 */
export interface WireCellObject {
  readonly t?: string;
  readonly f?: WireColor;
  readonly b?: WireColor;
  readonly a?: number;
  readonly u?: number;
  readonly w?: number;
}

/**
 * A single cell. A blank default cell (space, default colors, no styling — the
 * common case) serializes as the literal number `0`; otherwise a `WireCellObject`.
 */
export type WireCell = 0 | WireCellObject;

// ---------------------------------------------------------------------------
// Shared index tables (pure data — used by both encoder and renderer)
// ---------------------------------------------------------------------------

/** Bitmask of text-decoration flags for `WireCellObject.a`. */
export const ATTR = {
  bold: 1,
  faint: 2,
  italic: 4,
  blink: 8,
  inverse: 16,
  invisible: 32,
  strikethrough: 64,
  overline: 128,
} as const;

/** Underline styles indexed by `WireCellObject.u` (0 = none, omitted on the wire). */
export const UNDERLINE = [
  "none",
  "single",
  "double",
  "curly",
  "dotted",
  "dashed",
] as const;

/** Cell widths indexed by `WireCellObject.w` (0 = narrow, omitted on the wire). */
export const WIDTH = ["narrow", "wide", "spacer_tail", "spacer_head"] as const;
