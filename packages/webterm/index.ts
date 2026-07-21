/**
 * webterm — the JSON-over-WebSocket terminal protocol plus the server-side
 * bridge that turns a PTY into streamed grid snapshots.
 *
 * Import `webterm/protocol` (type-only, browser-safe) from the client; import
 * from `webterm` on the server for the bridge + encoder.
 */

export { TerminalBridge, type TerminalBridgeOptions } from "./server";
export { serializeGrid, encodeCell } from "./encode";

export {
  ATTR,
  UNDERLINE,
  WIDTH,
  MIN_TERMINAL_COLS,
  MAX_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  MAX_TERMINAL_ROWS,
  MAX_INPUT_BYTES,
  MAX_PENDING_BYTES,
  MAX_CLIENT_FRAME_BYTES,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  BUFFER_LIMIT_CLOSE_CODE,
  BUFFER_LIMIT_CLOSE_REASON,
  decodeClientMessage,
  decodeServerMessage,
  utf8ByteLength,
  clampTerminalSize,
  splitInput,
  type ClientMsg,
  type InitMsg,
  type InputMsg,
  type ResizeMsg,
  type ServerMsg,
  type GridMsg,
  type ExitMsg,
  type WireCursor,
  type WireCursorShape,
  type WireCell,
  type WireCellObject,
  type WireColor,
} from "./protocol";
