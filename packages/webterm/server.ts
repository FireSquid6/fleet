/**
 * server.ts — the server-side terminal bridge.
 *
 * A `TerminalBridge` owns one PTY subprocess (e.g. `tmux attach ...`) plus one
 * bun-vt `Terminal`. Raw bytes from the PTY are fed into the VT parser;
 * frames (coalesced to ~60fps) are pushed to a `send` callback. Client
 * keystrokes and resizes are forwarded to the PTY.
 *
 * What to actually put on the wire — a full `grid`, a `patch`, nothing at all,
 * or nothing *yet* because the client is behind — is decided by `FrameSequencer`,
 * which touches no PTY and no socket so the rules can be tested on their own.
 *
 * The bridge is transport-agnostic — the caller owns the WebSocket and just
 * wires `send` to `ws.send` and dispatches decoded `ClientMsg`s to the methods
 * here.
 */

import { Terminal as VtTerminal } from "bun-vt";
import { colorsEqual, diffGrid, serializeGrid } from "./encode";
import type { ClientMsg, GridMsg, PatchMsg, ServerMsg, WireCursor } from "./protocol";

export type FrameDecision =
  | { readonly kind: "send"; readonly msg: GridMsg | PatchMsg }
  /** Nothing changed since the last frame — no `seq` is consumed. */
  | { readonly kind: "idle" }
  /** The window is closed; retry when an ack arrives. */
  | { readonly kind: "blocked" };

export interface FrameSequencerOptions {
  /** Frames that may be in flight unacked before the sequencer stops sending. Default 2. */
  readonly maxUnackedFrames?: number;
  /** How long to wait for an ack before sending a full snapshot anyway. Default 5000. */
  readonly ackTimeoutMs?: number;
  /** Transport-level congestion signal; while true the sequencer blocks. Default: never. */
  readonly congested?: () => boolean;
  /** Clock, injectable for tests. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Whole-cursor comparison, every field. A cursor move with no cell change is a
 * real change the client must be told about, so this is what separates a
 * genuinely idle terminal from one where only the caret moved.
 */
function cursorsEqual(a: WireCursor, b: WireCursor): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.visible === b.visible &&
    a.shape === b.shape &&
    a.blinking === b.blinking &&
    colorsEqual(a.color, b.color)
  );
}

/**
 * Decides what the next frame on a connection should be: a full `grid`, a
 * `patch` against the last frame *actually sent*, or nothing.
 *
 * Two things bound it. The diff baseline is the last sent frame, never the last
 * computed one, so coalescing and pacing stay lossless. And an ack window caps
 * how many frames may be in flight: without it the sender never asks whether
 * the receiver is keeping up, and a slow link accumulates unbounded lag.
 */
export class FrameSequencer {
  private readonly maxUnackedFrames: number;
  private readonly ackTimeoutMs: number;
  private readonly congested: () => boolean;
  private readonly now: () => number;

  /** The last frame put on the wire, as a full snapshot — the diff baseline. */
  private lastSent: GridMsg | null = null;
  private nextSeq = 0;
  /** Frames sent but not yet acked, oldest first. */
  private unacked: { readonly seq: number; readonly at: number }[] = [];
  private forceFull = false;

  constructor(options: FrameSequencerOptions = {}) {
    this.maxUnackedFrames = options.maxUnackedFrames ?? 2;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
    this.congested = options.congested ?? (() => false);
    this.now = options.now ?? Date.now;
  }

  /**
   * Decide what to send for the terminal's current state. `grid` is whatever
   * `serializeGrid` produced; its `seq` is ignored and restamped here, so the
   * caller never has to thread a frame counter through the encoder.
   */
  next(grid: GridMsg): FrameDecision {
    const now = this.now();
    if (this.congested() || this.unacked.length >= this.maxUnackedFrames) {
      const oldest = this.unacked[0];
      if (oldest === undefined || now - oldest.at < this.ackTimeoutMs) return { kind: "blocked" };
      // Safety valve, not part of the normal path: a client that never acks (an
      // older build, a wedged renderer) would otherwise freeze forever. One full
      // snapshot every ackTimeoutMs is the pre-existing behavior degraded, not a
      // hang, and a full frame is what a client in an unknown state can use.
      this.forceFull = true;
      this.unacked = [];
    }

    const prev = this.lastSent;
    const seq = this.nextSeq;
    const snapshot: GridMsg = { ...grid, seq };

    // A patch cannot cross a resize: `applyPatch` throws on a dimension
    // mismatch, so a differently sized grid has to go out whole.
    if (prev === null || this.forceFull || prev.cols !== grid.cols || prev.rows !== grid.rows) {
      return this.emit(snapshot, snapshot, now);
    }

    const runs = diffGrid(prev, grid);
    if (runs.length === 0 && cursorsEqual(prev.cursor, grid.cursor)) return { kind: "idle" };

    const patch: PatchMsg = { type: "patch", seq, cols: grid.cols, rows: grid.rows, cursor: grid.cursor, runs };
    return this.emit(snapshot, patch, now);
  }

  /** Advance the acknowledged high-water mark. Unknown and stale `seq`s are ignored. */
  ack(seq: number): void {
    if (seq >= this.nextSeq) return;
    this.unacked = this.unacked.filter((frame) => frame.seq > seq);
  }

  /**
   * The client lost sequence: send a full snapshot next, and reopen the window.
   * Reopening is not optional — a client that has given up on the stream stops
   * acking, so a window left closed here never reopens and the terminal wedges.
   */
  requestResync(): void {
    this.forceFull = true;
    this.unacked = [];
  }

  private emit(snapshot: GridMsg, msg: GridMsg | PatchMsg, at: number): FrameDecision {
    this.lastSent = snapshot;
    this.nextSeq = snapshot.seq + 1;
    this.unacked.push({ seq: snapshot.seq, at });
    this.forceFull = false;
    return { kind: "send", msg };
  }
}

export interface TerminalBridgeOptions extends FrameSequencerOptions {
  /** argv for the PTY process, e.g. `["tmux", "-L", "fleet-ship", "attach", "-t", name]`. */
  readonly argv: string[];
  /** Sink for server→client messages (grid snapshots, patches, exit). */
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
  private readonly sequencer: FrameSequencer;

  private vt: VtTerminal | null = null;
  private proc: Bun.Subprocess | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  /** A frame the sequencer refused to send; an `ack` is what releases it. */
  private frameOwed = false;
  private started = false;
  private stopped = false;

  constructor(options: TerminalBridgeOptions) {
    this.argv = options.argv;
    this.send = options.send;
    this.frameIntervalMs = options.frameIntervalMs ?? 16;
    this.termName = options.termName ?? "xterm-256color";
    this.sequencer = new FrameSequencer(options);
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
      case "ack":
        this.sequencer.ack(msg.seq);
        if (this.frameOwed) this.scheduleFrame();
        break;
      case "resync":
        this.sequencer.requestResync();
        // Unconditionally, unlike `ack`: the client is painting nothing until
        // the snapshot it asked for arrives, and on a quiet terminal there is
        // no next PTY byte to schedule one.
        this.scheduleFrame();
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
    this.frameOwed = false;
    this.vt?.free();
    this.vt = null;
    this.proc = null;
  }

  /**
   * Coalesce a burst of PTY output into one decision per interval. A `blocked`
   * decision deliberately leaves the timer disarmed: re-arming it would spin
   * against a client that is already behind, so the next `ack` restarts the
   * stream instead (and, while blocked, further PTY output re-arms it, which is
   * also when the sequencer's ack timeout gets re-examined).
   */
  private scheduleFrame(): void {
    if (this.frameTimer !== null || this.stopped) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      if (this.stopped || !this.vt) return;
      const decision = this.sequencer.next(serializeGrid(this.vt));
      this.frameOwed = decision.kind === "blocked";
      if (decision.kind === "send") this.send(decision.msg);
    }, this.frameIntervalMs);
  }
}
