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

import { z } from "zod";

export const MIN_TERMINAL_COLS = 1;
export const MAX_TERMINAL_COLS = 1024;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_ROWS = 512;
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_PENDING_BYTES = 256 * 1024;
export const MAX_CLIENT_FRAME_BYTES = MAX_INPUT_BYTES * 6 + 128;

export const INVALID_MESSAGE_CLOSE_CODE = 1008;
export const INVALID_MESSAGE_CLOSE_REASON = "Invalid terminal message";
export const BINARY_MESSAGE_CLOSE_CODE = 1003;
export const BINARY_MESSAGE_CLOSE_REASON = "Binary terminal messages are not supported";
export const BUFFER_LIMIT_CLOSE_CODE = 1009;
export const BUFFER_LIMIT_CLOSE_REASON = "Terminal buffer limit exceeded";

const utf8 = new TextEncoder();
const colsSchema = z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS);
const rowsSchema = z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS);
const inputSchema = z.string().refine((data) => utf8.encode(data).byteLength <= MAX_INPUT_BYTES);

const InitMsgSchema = z.strictObject({ type: z.literal("init"), cols: colsSchema, rows: rowsSchema });
const InputMsgSchema = z.strictObject({ type: z.literal("input"), data: inputSchema });
const ResizeMsgSchema = z.strictObject({ type: z.literal("resize"), cols: colsSchema, rows: rowsSchema });
const ClientMsgSchema = z.discriminatedUnion("type", [InitMsgSchema, InputMsgSchema, ResizeMsgSchema]);

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

export type WireCursorShape = "block" | "underline" | "bar";

/** Cursor position and appearance within the active screen. */
export interface WireCursor {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  readonly shape?: WireCursorShape;
  readonly blinking?: boolean;
  readonly color?: WireColor;
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

const byteSchema = z.number().int().min(0).max(255);
const WireColorSchema = z.union([byteSchema, z.tuple([byteSchema, byteSchema, byteSchema])]);
const WireCellSchema = z.union([
  z.literal(0),
  z.strictObject({
    t: z.string().optional(),
    f: WireColorSchema.optional(),
    b: WireColorSchema.optional(),
    a: byteSchema.optional(),
    u: z.number().int().min(1).max(5).optional(),
    w: z.number().int().min(1).max(3).optional(),
  }),
]);
const WireCursorSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  visible: z.boolean(),
  shape: z.enum(["block", "underline", "bar"]).optional(),
  blinking: z.boolean().optional(),
  color: WireColorSchema.optional(),
});
const GridMsgSchema = z
  .strictObject({
    type: z.literal("grid"),
    cols: colsSchema,
    rows: rowsSchema,
    cursor: WireCursorSchema,
    cells: z.array(z.array(WireCellSchema)),
  })
  .superRefine((grid, ctx) => {
    if (grid.cells.length !== grid.rows || grid.cells.some((row) => row.length !== grid.cols)) {
      ctx.addIssue({ code: "custom", message: "grid dimensions do not match cells" });
    }
    if (grid.cursor.x >= grid.cols || grid.cursor.y >= grid.rows) {
      ctx.addIssue({ code: "custom", message: "cursor is outside grid" });
    }
  });
const ExitMsgSchema = z.strictObject({ type: z.literal("exit"), code: z.number().int() });
const ServerMsgSchema = z.discriminatedUnion("type", [GridMsgSchema, ExitMsgSchema]);

function parseJsonFrame(frame: unknown): unknown {
  if (typeof frame === "string") return JSON.parse(frame);
  if (frame !== null && typeof frame === "object" && !ArrayBuffer.isView(frame) && !(frame instanceof ArrayBuffer)) {
    return frame;
  }
  throw new TypeError("terminal frames must be text");
}

export function decodeClientMessage(frame: unknown): ClientMsg {
  return ClientMsgSchema.parse(parseJsonFrame(frame));
}

export function decodeServerMessage(frame: unknown): ServerMsg {
  return ServerMsgSchema.parse(parseJsonFrame(frame));
}

export function utf8ByteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.min(MAX_TERMINAL_COLS, Math.max(MIN_TERMINAL_COLS, Math.trunc(Number.isFinite(cols) ? cols : 0))),
    rows: Math.min(MAX_TERMINAL_ROWS, Math.max(MIN_TERMINAL_ROWS, Math.trunc(Number.isFinite(rows) ? rows : 0))),
  };
}

export function splitInput(data: string): string[] {
  if (utf8ByteLength(data) <= MAX_INPUT_BYTES) return [data];

  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of data) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > MAX_INPUT_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

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
