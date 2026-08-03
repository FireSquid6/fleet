import { useCallback, useEffect, useRef, useState } from "react";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  clampTerminalSize,
  decodeServerMessage,
  GridStream,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  splitInput,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  TERMINAL_TAKEOVER_QUERY,
} from "webterm/protocol";
import type { ClientMsg, GridMsg } from "webterm/protocol";
import { ticketedWsUrl } from "./auth";

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
  /** Called with each complete snapshot, whether the server sent it whole or as a
   *  patch. Kept out of React state on purpose — the caller paints imperatively
   *  so 60fps snapshots don't re-render the tree. */
  onGrid?: (grid: GridMsg) => void;
  onExit?: (code: number) => void;
}

export function handleServerFrame(
  data: unknown,
  stream: GridStream,
  opts: UseWebtermOptions,
  send: (msg: ClientMsg) => void,
  close: (code: number, reason: string) => void,
): void {
  if (typeof data !== "string") {
    close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
    return;
  }
  try {
    const msg = decodeServerMessage(data);
    if (msg.type === "exit") {
      opts.onExit?.(msg.code);
      return;
    }
    const { grid, reply } = stream.accept(msg);
    if (reply) send(reply);
    if (grid) opts.onGrid?.(grid);
  } catch {
    close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
  }
}

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
 * Opens the WebSocket only while `active`, tearing it down (and releasing the
 * ship's single-terminal guard) when `active` goes false or on unmount.
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
  /**
   * The most recent size `resize()` reported, replayed to every socket as it
   * opens. It deliberately survives reconnects: the canvas is unchanged, and
   * nothing re-measures it (the caller's ResizeObserver only fires on an actual
   * resize), so dropping it would leave a reconnected socket un-`init`ed — which
   * the ship closes after 5s. Resetting `initializedRef` is what makes the
   * replay an `init` rather than a `resize`.
   */
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Frames never go through React state: they arrive at up to 60fps and the
  // caller paints imperatively.
  const streamRef = useRef(new GridStream());
  // Bumping the attempt is what re-runs the socket effect; the flag rides in a
  // ref that the effect consumes, so eviction applies to that attempt alone and
  // never to a later reconnect.
  const [attempt, setAttempt] = useState(0);
  const takeoverRef = useRef(false);

  // Keep callbacks current without re-running the socket effect.
  const optsRef = useRef(opts);
  optsRef.current = opts;

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
    // A fresh socket needs `init` before anything else; `lastSizeRef` carries over.
    initializedRef.current = false;
    // The new connection numbers its frames from scratch, and a snapshot left
    // over from the previous one is not a baseline any of its patches anchor to.
    streamRef.current.reset();
    setStatus("connecting");

    let cancelled = false;
    let ws: WebSocket | null = null;

    void (async () => {
      const url = await ticketedWsUrl(terminalPath(repo, name, requestTakeover));
      if (cancelled) return;
      const socket = new WebSocket(url);
      ws = socket;
      wsRef.current = socket;

      socket.onopen = () => {
        setStatus("open");
        const size = lastSizeRef.current;
        if (size) sendSize(socket, size.cols, size.rows);
      };
      socket.onmessage = (ev) => {
        handleServerFrame(
          ev.data,
          streamRef.current,
          optsRef.current,
          (msg) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
          },
          (code, reason) => socket.close(code, reason),
        );
      };
      socket.onclose = (ev) => setStatus(closeStatus(ev.code));
      // An error event can trail a close (e.g. the ship refusing the attach), and
      // "connection failed" would hide the conflict UI that lets the user recover.
      socket.onerror = () =>
        setStatus((prev) => (prev === "conflict" || prev === "superseded" ? prev : "error"));
    })();

    return () => {
      cancelled = true;
      wsRef.current = null;
      if (!ws) return;
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
      lastSizeRef.current = { cols, rows };
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
