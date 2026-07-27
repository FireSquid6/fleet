/**
 * server.ts — the server-side terminal bridge.
 *
 * A `TerminalBridge` owns one PTY subprocess (e.g. `tmux attach ...`) plus one
 * bun-vt `Terminal`. Raw bytes from the PTY are fed into the VT parser;
 * grid snapshots (coalesced to ~60fps) are pushed to a `send` callback. Client
 * keystrokes and resizes are forwarded to the PTY.
 *
 * The bridge is transport-agnostic — the caller owns the WebSocket and just
 * wires `send` to `ws.send` and dispatches decoded `ClientMsg`s to the methods
 * here.
 */

import { Terminal as VtTerminal } from "bun-vt";
import { serializeGrid } from "./encode";
import { PASTE_END, PASTE_START, pasteBytes } from "./protocol";
import type { ClientMsg, ServerMsg } from "./protocol";

/** What `pasteBytes` returns, bracketed, for a paste whose payload stripped to nothing. */
const EMPTY_BRACKETED_PASTE = PASTE_START + PASTE_END;

export interface TerminalBridgeOptions {
  /** argv for the PTY process, e.g. `["tmux", "-L", "fleet-ship", "attach", "-t", name]`. */
  readonly argv: string[];
  /** Sink for server→client messages (grid snapshots, exit). */
  readonly send: (msg: ServerMsg) => void;
  /** Frame coalescing interval in ms. Default ~16 (60fps). */
  readonly frameIntervalMs?: number;
  /** TERM name advertised to the child. Default "xterm-256color". */
  readonly termName?: string;
}

export class TerminalBridge {
  private readonly argv: string[];
  private readonly send: (msg: ServerMsg) => void;
  private readonly frameIntervalMs: number;
  private readonly termName: string;

  private vt: VtTerminal | null = null;
  private proc: Bun.Subprocess | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;

  constructor(options: TerminalBridgeOptions) {
    this.argv = options.argv;
    this.send = options.send;
    this.frameIntervalMs = options.frameIntervalMs ?? 16;
    this.termName = options.termName ?? "xterm-256color";
  }

  /** Allocate the VT parser and spawn the PTY process at the given size. Idempotent. */
  start(cols: number, rows: number): void {
    if (this.started || this.stopped) return;
    this.started = true;

    this.vt = new VtTerminal({ cols, rows });

    this.proc = Bun.spawn(this.argv, {
      terminal: {
        cols,
        rows,
        name: this.termName,
        data: (_term, bytes) => {
          if (this.stopped || !this.vt) return;
          this.vt.write(bytes);
          this.scheduleFrame();
        },
        exit: (_term, code) => {
          if (this.stopped) return;
          this.send({ type: "exit", code });
          this.cleanup();
        },
      },
    });
  }

  input(data: string): void {
    this.proc?.terminal?.write(data);
  }

  /**
   * Write one complete paste. The VT is consulted here rather than on the client
   * because only this side knows whether the application enabled mode 2004.
   *
   * Until it is known, the paste goes out unbracketed — not because that is the
   * safer form (it is the more permissive one: inside a bracketed region tmux
   * ignores its own prefix key, so an unbracketed paste of prefix sequences acts
   * on tmux where a bracketed one could not) but because it is the only thing we
   * can write without inventing a mode the application never asked for. The window
   * is wider than "before `init`": after it the VT exists but reads `false` until
   * the attach output carrying `?2004h` has been parsed, and it reopens on every
   * reconnect, each of which builds a fresh `Terminal`. Dropping pastes for that
   * interval would be worse than sending them plain.
   */
  paste(data: string): void {
    const bytes = pasteBytes(data, this.vt?.bracketedPaste ?? false);
    // A clipboard that survives stripping as nothing — empty, or nothing but
    // closing markers — must not reach the PTY: bracketed, it would be a bare
    // marker pair, which an application reports as a paste of no text (Claude Code
    // renders an empty `[Pasted text …]`). The client drops the empty string
    // early, but only the post-strip payload settles the marker-only case, and
    // `pasteBytes` wraps before returning, so the emptiness test is on its output.
    // Length alone decides it: `bytes` is the payload plus the two markers.
    if (bytes === "" || bytes === EMPTY_BRACKETED_PASTE) return;
    this.proc?.terminal?.write(bytes);
  }

  /** Resize both the PTY and the VT parser, then repaint. */
  resize(cols: number, rows: number): void {
    if (this.stopped) return;
    this.proc?.terminal?.resize(cols, rows);
    this.vt?.resize(cols, rows);
    this.scheduleFrame();
  }

  handle(msg: ClientMsg): void {
    switch (msg.type) {
      case "init":
        this.start(msg.cols, msg.rows);
        break;
      case "input":
        this.input(msg.data);
        break;
      case "paste":
        this.paste(msg.data);
        break;
      case "resize":
        this.resize(msg.cols, msg.rows);
        break;
    }
  }

  /** Kill the PTY and free the VT parser. Idempotent; does not emit `exit`. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.proc?.kill();
    } catch {
      // process may already be gone
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.vt?.free();
    this.vt = null;
    this.proc = null;
  }

  private scheduleFrame(): void {
    if (this.frameTimer !== null || this.stopped) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      if (this.stopped || !this.vt) return;
      this.send(serializeGrid(this.vt));
    }, this.frameIntervalMs);
  }
}
