/**
 * ws.ts — construct a WebSocket with optional headers.
 *
 * Bun's `WebSocket` accepts a `{ headers }` init object (used to present the
 * service token on server-opened sockets), but the DOM `lib` type — which the
 * frontend's tsconfig applies when it compiles the bridge's route types for Eden
 * — only models `protocols`. The cast keeps both compilers happy; at runtime the
 * object reaches Bun unchanged.
 */

export type WebSocketInit = { headers?: Record<string, string> };

export function openWebSocket(url: string, init?: WebSocketInit): WebSocket {
  return new WebSocket(url, init as unknown as string | string[] | undefined);
}
