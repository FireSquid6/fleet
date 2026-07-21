import { useCallback, useEffect, useRef, useState } from "react";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  clampTerminalSize,
  decodeServerMessage,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  splitInput,
} from "webterm/protocol";
import type { GridMsg } from "webterm/protocol";
import { wsBridgeUrl } from "./client";

export type WebtermStatus = "idle" | "connecting" | "open" | "closed" | "error";

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

export function terminalPath(repo: string, name: string): string {
  return `/workspaces/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/terminal`;
}

interface UseWebtermResult {
  status: WebtermStatus;
  /** Write keystroke/paste bytes to the PTY. */
  send: (data: string) => void;
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
    if (!active) {
      setStatus("idle");
      return;
    }
    initializedRef.current = false;
    pendingSizeRef.current = null;
    setStatus("connecting");

    const ws = new WebSocket(wsBridgeUrl(terminalPath(repo, name)));
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("open");
      const pending = pendingSizeRef.current;
      if (pending) sendSize(ws, pending.cols, pending.rows);
    };
    ws.onmessage = (ev) => {
      handleServerFrame(ev.data, optsRef.current, (code, reason) => ws.close(code, reason));
    };
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("error");

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [repo, name, active, sendSize]);

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

  return { status, send, resize };
}
