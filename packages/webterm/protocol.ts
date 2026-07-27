/**
 * webterm/protocol.ts — the JSON-over-WebSocket contract between the browser and
 * the Bun server. Both sides import from this file. It contains only type
 * definitions plus a few pure data tables (no PTY / no VT emulator), so it is
 * safe to bundle straight into the browser.
 *
 * The server is the terminal emulator: it parses the shell's raw VT bytes with
 * bun-vt into a cell grid and streams it to the client, either as a full `grid`
 * snapshot or as a `patch` delta against the previous frame. The client only
 * paints cells and sends keystrokes.
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

// A workspace's tmux session accepts one terminal socket at a time. Both codes
// sit in the 4000–4999 private range so every proxy in the chain forwards them
// verbatim instead of collapsing them to 1011; reasons stay well under the
// WebSocket 123-byte limit.
/** Refused: another connection already owns this workspace's terminal. */
export const TERMINAL_CONFLICT_CLOSE_CODE = 4409;
export const TERMINAL_CONFLICT_CLOSE_REASON = "Terminal already attached by another connection";
/** Evicted: another connection took this workspace's terminal over. */
export const TERMINAL_TAKEOVER_CLOSE_CODE = 4410;
export const TERMINAL_TAKEOVER_CLOSE_REASON = "Terminal taken over by another connection";

/**
 * Query param on the terminal ws URL asking to evict the incumbent connection.
 * Decoded as a boolean by the route schemas, so producers must write `true`.
 */
export const TERMINAL_TAKEOVER_QUERY = "takeover";

const utf8 = new TextEncoder();
const colsSchema = z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS);
const rowsSchema = z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS);
const inputSchema = z.string().refine((data) => utf8.encode(data).byteLength <= MAX_INPUT_BYTES);

const seqSchema = z.number().int().nonnegative();

const InitMsgSchema = z.strictObject({ type: z.literal("init"), cols: colsSchema, rows: rowsSchema });
const InputMsgSchema = z.strictObject({ type: z.literal("input"), data: inputSchema });
const ResizeMsgSchema = z.strictObject({ type: z.literal("resize"), cols: colsSchema, rows: rowsSchema });
const AckMsgSchema = z.strictObject({ type: z.literal("ack"), seq: seqSchema });
const ResyncMsgSchema = z.strictObject({ type: z.literal("resync") });
const ClientMsgSchema = z.discriminatedUnion("type", [
  InitMsgSchema,
  InputMsgSchema,
  ResizeMsgSchema,
  AckMsgSchema,
  ResyncMsgSchema,
]);

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

/** Acknowledge receipt of the server frame with this `seq`. */
export interface AckMsg {
  readonly type: "ack";
  readonly seq: number;
}

/** Ask the server for a full `grid` frame (recovery from a sequence gap). */
export interface ResyncMsg {
  readonly type: "resync";
}

export type ClientMsg = InitMsg | InputMsg | ResizeMsg | AckMsg | ResyncMsg;

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

/**
 * A full active-screen snapshot to paint. `cells` is indexed `cells[row][col]`.
 *
 * `seq` counts frames on this connection: it is the anchor a `patch` deltas
 * against, so a client that misses a frame can detect the gap and `resync`.
 */
export interface GridMsg {
  readonly type: "grid";
  readonly seq: number;
  readonly cols: number;
  readonly rows: number;
  readonly cursor: WireCursor;
  readonly cells: WireCell[][];
}

/** A run of consecutive changed cells in one row: [row, col, cells]. */
export type PatchRun = readonly [number, number, readonly WireCell[]];

/**
 * A delta against the frame with `seq - 1`. Only valid applied to that exact
 * frame; a client holding anything else must ask for a full `grid` instead.
 */
export interface PatchMsg {
  readonly type: "patch";
  readonly seq: number;
  readonly cols: number;
  readonly rows: number;
  readonly cursor: WireCursor;
  readonly runs: readonly PatchRun[];
}

/** Shell exited; the connection is closing. */
export interface ExitMsg {
  readonly type: "exit";
  readonly code: number;
}

export type ServerMsg = GridMsg | PatchMsg | ExitMsg;

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
    seq: seqSchema,
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
const PatchRunSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.array(WireCellSchema).min(1),
]);
const PatchMsgSchema = z
  .strictObject({
    type: z.literal("patch"),
    seq: seqSchema,
    cols: colsSchema,
    rows: rowsSchema,
    cursor: WireCursorSchema,
    runs: z.array(PatchRunSchema),
  })
  .superRefine((patch, ctx) => {
    if (patch.cursor.x >= patch.cols || patch.cursor.y >= patch.rows) {
      ctx.addIssue({ code: "custom", message: "cursor is outside grid" });
    }
    // A run that would write past the right edge is a decode failure rather
    // than a clamp, so the renderer can apply runs without bounds checks.
    for (const [row, col, cells] of patch.runs) {
      if (row >= patch.rows || col + cells.length > patch.cols) {
        ctx.addIssue({ code: "custom", message: "patch run is outside grid" });
      }
    }
  });
const ExitMsgSchema = z.strictObject({ type: z.literal("exit"), code: z.number().int() });
const ServerMsgSchema = z.discriminatedUnion("type", [GridMsgSchema, PatchMsgSchema, ExitMsgSchema]);

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

/**
 * Apply a delta to the snapshot it was computed against, returning the new
 * snapshot. `prev` is never mutated — the client repaints from the object it
 * already holds — and rows no run touches are shared with `prev` rather than
 * copied.
 *
 * Throws on a dimension mismatch: the patch anchors to a differently sized
 * frame, and the caller's recovery is to ask for a full `grid`.
 */
export function applyPatch(prev: GridMsg, patch: PatchMsg): GridMsg {
  if (patch.cols !== prev.cols || patch.rows !== prev.rows) {
    throw new TypeError("patch dimensions do not match the previous grid");
  }

  const cells = prev.cells.slice();
  const copied = new Set<number>();
  for (const [row, col, run] of patch.runs) {
    if (!copied.has(row)) {
      cells[row] = cells[row]!.slice();
      copied.add(row);
    }
    const target = cells[row]!;
    for (let i = 0; i < run.length; i++) {
      target[col + i] = run[i]!;
    }
  }

  return { type: "grid", seq: patch.seq, cols: patch.cols, rows: patch.rows, cursor: patch.cursor, cells };
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
