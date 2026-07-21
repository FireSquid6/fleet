import { serve, type Server, type ServerWebSocket } from "bun";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  BUFFER_LIMIT_CLOSE_CODE,
  BUFFER_LIMIT_CLOSE_REASON,
  decodeClientMessage,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  MAX_CLIENT_FRAME_BYTES,
  MAX_PENDING_BYTES,
  utf8ByteLength,
} from "webterm/protocol";
import index from "./index.html";

/** Per-connection state for a proxied `/bridge/*` WebSocket. */
export interface BridgeWsData {
  upstream: WebSocket;
  /** Frames the browser sent before `upstream` reached OPEN (e.g. the terminal's first `init`). */
  buffer: string[];
  pendingBytes: number;
}

type CreateWebSocket = (url: string) => WebSocket;

export function upgradeBridgeWebSocket(
  req: Request,
  server: Pick<Server<BridgeWsData>, "upgrade">,
  target: string,
  createWebSocket: CreateWebSocket = (url) => new WebSocket(url),
): Response | undefined {
  const upstream = createWebSocket(target);
  const data: BridgeWsData = { upstream, buffer: [], pendingBytes: 0 };
  if (server.upgrade(req, { data })) return undefined;

  data.buffer.length = 0;
  data.pendingBytes = 0;
  upstream.onopen = null;
  upstream.onmessage = null;
  upstream.onclose = null;
  upstream.onerror = null;
  upstream.close();
  return new Response("Upgrade failed", { status: 500 });
}

export function startClientServer(
  bridgeUrl: string,
  port?: number,
  deps?: { createWebSocket?: CreateWebSocket },
) {
  /**
   * Real bridge origin the `/bridge/*` proxy forwards to. Configure with the
   * `BRIDGE_URL` env var; defaults to a local bridge.
   */
  const bridgeWSUrl = bridgeUrl.replace(/^http/, "ws");


  /** Strip the `/bridge` prefix, preserving path + query (defaults to `/`). */
  function bridgePath(url: URL): string {
    return (url.pathname.replace(/^\/bridge/, "") || "/") + url.search;
  }

  /**
   * Reverse-proxy `/bridge/<path>` → `${BRIDGE_URL}/<path>`. The browser's Eden
   * treaty talks to this same-origin prefix, so the bridge needs no CORS config.
   * WebSocket upgrades (the terminal stream) are proxied too — Bun `fetch` can't
   * forward an upgrade, so we open our own upstream socket and pipe frames.
   */
  async function proxyToBridge(req: Request, server: Server<BridgeWsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = bridgePath(url);

    if (req.headers.get("upgrade") === "websocket") {
      return upgradeBridgeWebSocket(req, server, bridgeWSUrl + path, deps?.createWebSocket);
    }

    const target = bridgeUrl + path;
    const headers = new Headers(req.headers);
    headers.delete("host");

    const init: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();

    try {
      return await fetch(target, init);
    } catch (err) {
      return Response.json(
        { error: `bridge unreachable at ${bridgeUrl}: ${(err as Error).message}` },
        { status: 502 },
      );
    }
  }
  const server = serve({
    port,
    routes: {
      "/bridge/*": proxyToBridge,

      // SPA: every other path resolves to the client bundle so react-router can
      // handle deep links (e.g. /repos/api-gateway/workspaces/ws-4f2a) on refresh.
      "/*": index,
    },

    // Dumb bidirectional pipe between the browser and the real bridge. Buffer
    // client frames until the upstream socket is open so the first `init` isn't
    // lost (mirrors the bridge→ship proxy in fleet-bridge's workspaces plugin).
    websocket: {
      maxPayloadLength: MAX_CLIENT_FRAME_BYTES,
      open(ws: ServerWebSocket<BridgeWsData>) {
        const { upstream, buffer } = ws.data;
        upstream.onopen = () => {
          for (const frame of buffer) upstream.send(frame);
          buffer.length = 0;
          ws.data.pendingBytes = 0;
        };
        upstream.onmessage = (event) => {
          if (typeof event.data === "string") {
            ws.send(event.data);
            return;
          }
          buffer.length = 0;
          ws.data.pendingBytes = 0;
          ws.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          upstream.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
        };
        upstream.onclose = (event) => {
          buffer.length = 0;
          ws.data.pendingBytes = 0;
          try {
            ws.close(event.code, event.reason);
          } catch {
            // already closed
          }
        };
        upstream.onerror = () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
        };
      },
      message(ws: ServerWebSocket<BridgeWsData>, message) {
        const { upstream, buffer } = ws.data;
        if (typeof message !== "string") {
          buffer.length = 0;
          ws.data.pendingBytes = 0;
          upstream.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          ws.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          return;
        }
        let frame: string;
        try {
          frame = JSON.stringify(decodeClientMessage(message));
        } catch {
          buffer.length = 0;
          ws.data.pendingBytes = 0;
          upstream.close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
          ws.close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else {
          const pendingBytes = ws.data.pendingBytes + utf8ByteLength(frame);
          if (pendingBytes > MAX_PENDING_BYTES) {
            buffer.length = 0;
            ws.data.pendingBytes = 0;
            upstream.close(BUFFER_LIMIT_CLOSE_CODE, BUFFER_LIMIT_CLOSE_REASON);
            ws.close(BUFFER_LIMIT_CLOSE_CODE, BUFFER_LIMIT_CLOSE_REASON);
            return;
          }
          buffer.push(frame);
          ws.data.pendingBytes = pendingBytes;
        }
      },
      close(ws: ServerWebSocket<BridgeWsData>, code, reason) {
        ws.data.buffer.length = 0;
        ws.data.pendingBytes = 0;
        try {
          ws.data.upstream.close(code, reason);
        } catch {
          // already closed
        }
      },
    },

    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
  });

  console.log(`Started client on ${server.url}, forwarding to ${bridgeUrl}`);
  return server;
}
