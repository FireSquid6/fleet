import { serve, type Server, type ServerWebSocket } from "bun";
import index from "./index.html";

/** Per-connection state for a proxied `/bridge/*` WebSocket. */
interface BridgeWsData {
  upstream: WebSocket;
  /** Frames the browser sent before `upstream` reached OPEN (e.g. the terminal's first `init`). */
  buffer: string[];
}



export function startClientServer(bridgeUrl: string) {
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
      const upstream = new WebSocket(bridgeWSUrl + path);
      const data: BridgeWsData = { upstream, buffer: [] };
      if (!server.upgrade(req, { data })) return new Response("Upgrade failed", { status: 500 });
      return undefined;
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
      open(ws: ServerWebSocket<BridgeWsData>) {
        const { upstream, buffer } = ws.data;
        upstream.onopen = () => {
          for (const frame of buffer) upstream.send(frame);
          buffer.length = 0;
        };
        upstream.onmessage = (ev) => ws.send(typeof ev.data === "string" ? ev.data : String(ev.data));
        upstream.onclose = () => {
          try {
            ws.close();
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
        const frame = typeof message === "string" ? message : message.toString();
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else buffer.push(frame);
      },
      close(ws: ServerWebSocket<BridgeWsData>) {
        try {
          ws.data.upstream.close();
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

  console.log(`Started client on ${server.url}`);
}

