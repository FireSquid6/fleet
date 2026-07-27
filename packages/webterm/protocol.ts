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

const InitMsgSchema = z.strictObject({ type: z.literal("init"), cols: colsSchema, rows: rowsSchema });
const InputMsgSchema = z.strictObject({ type: z.literal("input"), data: inputSchema });
const PasteMsgSchema = z.strictObject({ type: z.literal("paste"), data: inputSchema });
const ResizeMsgSchema = z.strictObject({ type: z.literal("resize"), cols: colsSchema, rows: rowsSchema });
const ClientMsgSchema = z.discriminatedUnion("type", [InitMsgSchema, InputMsgSchema, PasteMsgSchema, ResizeMsgSchema]);

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** First message: allocate a Terminal and spawn the shell at this size. */
export interface InitMsg {
  readonly type: "init";
  readonly cols: number;
  readonly rows: number;
}

/** Keystrokes to write to the PTY. */
export interface InputMsg {
  readonly type: "input";
  readonly data: string;
}

/**
 * Clipboard text the user pasted. Distinct from `input` because the client must
 * not decide the bytes: only the server holds the VT and therefore knows whether
 * the application enabled bracketed paste, so it converts the text via
 * `pasteBytes`.
 *
 * Every message is one *complete* paste. `data` is bounded by `MAX_INPUT_BYTES`
 * like `input`, so a larger clipboard is split by the client into several
 * consecutive complete pastes, each independently bracketed. That keeps the
 * server stateless — no half-open bracketed region can survive a mid-paste
 * disconnect and leave the application swallowing subsequent keystrokes — at the
 * cost of a >256 KiB clipboard arriving as more than one paste, which
 * applications handle as ordinary consecutive pastes.
 */
export interface PasteMsg {
  readonly type: "paste";
  readonly data: string;
}

/** Resize both the VT parser and the PTY. */
export interface ResizeMsg {
  readonly type: "resize";
  readonly cols: number;
  readonly rows: number;
}

export type ClientMsg = InitMsg | InputMsg | PasteMsg | ResizeMsg;

/** DECSET 2004 bracketed-paste markers, sent around a paste when the app asked for them. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * The bytes to write to the PTY for a paste of `data`. `bracketed` is whether the
 * application enabled DEC private mode 2004 (`Terminal.bracketedPaste`).
 *
 * Two normalizations apply either way. Line breaks become CR because that is what
 * a terminal delivers for Enter; leaving LF would make a pasted line break behave
 * differently from a typed one in readline-style applications. And any embedded
 * copy of the closing marker is dropped: it would otherwise end the bracketed
 * region early, so the clipboard's remaining bytes would be read as keystrokes
 * and escape sequences — a command-injection route for anything that can write to
 * the user's clipboard. Stripping it unconditionally keeps the bracketed and
 * unbracketed paths from diverging on what the payload may contain.
 */
export function pasteBytes(data: string, bracketed: boolean): string {
  let payload = data.replace(/\r\n|\n/g, "\r");
  // Repeat until clean: one `replaceAll` pass does not rescan the text it joins,
  // so `ESC[20` + `ESC[201~` + `1~` would collapse into a fresh closing marker.
  // Each pass strictly shortens the string, so this terminates.
  while (payload.includes(PASTE_END)) payload = payload.replaceAll(PASTE_END, "");
  return bracketed ? PASTE_START + payload + PASTE_END : payload;
}

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
