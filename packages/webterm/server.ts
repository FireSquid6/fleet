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
import type { ClientMsg, ServerMsg } from "./protocol";

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
