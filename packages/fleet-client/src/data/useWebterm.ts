import { useCallback, useEffect, useRef, useState } from "react";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  clampTerminalSize,
  decodeServerMessage,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  splitInput,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  TERMINAL_TAKEOVER_QUERY,
} from "webterm/protocol";
import type { GridMsg } from "webterm/protocol";
import { wsBridgeUrl } from "./client";

export type WebtermStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  /** Refused: the workspace's terminal is already attached elsewhere. */
  | "conflict"
  /** Evicted: another connection took this terminal over. */
  | "superseded"
  | "error";

interface UseWebtermOptions {
  /** Called on every grid frame. Kept out of React state on purpose — the caller
   *  paints imperatively so 60fps snapshots don't re-render the tree. */
  onGrid?: (grid: GridMsg) => void;
  onExit?: (code: number) => void;
}

export function handleServerFrame(
  data: unknown,
  opts: UseWebtermOptions,
  close: (code: number, reason: string) => void,
): void {
  if (typeof data !== "string") {
    close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
    return;
  }
  try {
    const msg = decodeServerMessage(data);
    if (msg.type === "grid") opts.onGrid?.(msg);
    else opts.onExit?.(msg.code);
  } catch {
    close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
  }
}

/** Status a closed socket leaves behind, derived from the ship's close code. */
export function closeStatus(code: number): WebtermStatus {
  if (code === TERMINAL_CONFLICT_CLOSE_CODE) return "conflict";
  if (code === TERMINAL_TAKEOVER_CLOSE_CODE) return "superseded";
  return "closed";
}

export function terminalPath(repo: string, name: string, takeover = false): string {
  const path = `/workspaces/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/terminal`;
  return takeover ? `${path}?${TERMINAL_TAKEOVER_QUERY}=true` : path;
}

interface UseWebtermResult {
  status: WebtermStatus;
  /** Write keystroke/paste bytes to the PTY. */
  send: (data: string) => void;
  /**
   * Reconnect, evicting whichever connection currently owns the workspace's
   * terminal. Meant for the `"conflict"` status.
   */
  takeover: () => void;
  /**
   * Report the terminal's current size in cells. The first call after the socket
   * opens sends `init` (which spawns the shell); every later call sends `resize`.
   * Calls before the socket is open are buffered and flushed on connect.
   */
  resize: (cols: number, rows: number) => void;
}

/**
 * Connect to a workspace's live terminal over the webterm grid protocol. Opens
 * the WebSocket only while `active`, tearing it down (and releasing the ship's
 * single-terminal guard) when `active` goes false or the component unmounts.
 */
export function useWebterm(
  repo: string,
  name: string,
  active: boolean,
  opts: UseWebtermOptions,
): UseWebtermResult {
  const [status, setStatus] = useState<WebtermStatus>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const initializedRef = useRef(false);
  const pendingSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Bumping the attempt is what re-runs the socket effect; the flag rides in a
  // ref that the effect consumes, so eviction applies to that attempt alone and
  // never to a later reconnect.
  const [attempt, setAttempt] = useState(0);
  const takeoverRef = useRef(false);

  // Keep callbacks current without re-running the socket effect.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** Send `init` the first time, `resize` thereafter. */
  const sendSize = useCallback((ws: WebSocket, cols: number, rows: number) => {
    ({ cols, rows } = clampTerminalSize(cols, rows));
    const type = initializedRef.current ? "resize" : "init";
    initializedRef.current = true;
    ws.send(JSON.stringify({ type, cols, rows }));
  }, []);

  useEffect(() => {
    // Consumed before the `active` bail-out: a takeover belongs to the attempt
    // that asked for it, and must not be replayed against whoever holds the
    // session the next time this workspace is attached.
    const requestTakeover = takeoverRef.current;
    takeoverRef.current = false;
    if (!active) {
      setStatus("idle");
      return;
    }
    // Keep the last reported cell size: the canvas is unchanged across a
    // reconnect, and nothing re-measures it (the caller's ResizeObserver only
    // fires on an actual resize). Clearing it here would leave `onopen` with
    // nothing to send, and the ship closes an un-`init`ed socket after 5s.
    // `initializedRef` is what makes the replay an `init` rather than a `resize`.
    initializedRef.current = false;
    setStatus("connecting");

    const ws = new WebSocket(wsBridgeUrl(terminalPath(repo, name, requestTakeover)));
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("open");
      const pending = pendingSizeRef.current;
      if (pending) sendSize(ws, pending.cols, pending.rows);
    };
    ws.onmessage = (ev) => {
      handleServerFrame(ev.data, optsRef.current, (code, reason) => ws.close(code, reason));
    };
    ws.onclose = (ev) => setStatus(closeStatus(ev.code));
    // An error event can trail a close (e.g. the ship refusing the attach), and
    // "connection failed" would hide the conflict UI that lets the user recover.
    ws.onerror = () => setStatus((prev) => (prev === "conflict" || prev === "superseded" ? prev : "error"));

    return () => {
      wsRef.current = null;
      // Detach first: this socket's close event would otherwise land after the
      // next attempt has already set its own status.
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    };
  }, [repo, name, active, attempt, sendSize]);

  const send = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      for (const chunk of splitInput(data)) ws.send(JSON.stringify({ type: "input", data: chunk }));
    }
  }, []);

  const resize = useCallback(
    (cols: number, rows: number) => {
      ({ cols, rows } = clampTerminalSize(cols, rows));
      pendingSizeRef.current = { cols, rows };
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) sendSize(ws, cols, rows);
    },
    [sendSize],
  );

  const takeover = useCallback(() => {
    takeoverRef.current = true;
    setAttempt((n) => n + 1);
  }, []);

  return { status, send, resize, takeover };
}
