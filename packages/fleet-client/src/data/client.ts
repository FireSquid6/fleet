import { treaty } from "@elysiajs/eden";
import type { App } from "fleet-bridge/api";

/** Fully-typed Eden client for the fleet bridge's HTTP surface. */
export type BridgeClient = ReturnType<typeof treaty<App>>;

/**
 * Base URL the treaty talks to. In the browser this is the fleet-client server's
 * own `/bridge` prefix, which is reverse-proxied to the real bridge (see
 * src/index.ts) — that keeps calls same-origin, so no CORS config on the bridge.
 * Off-browser (tests) it falls back to a direct bridge URL.
 */
export function bridgeBaseUrl(): string {
  if (typeof window !== "undefined") return `${window.location.origin}/bridge`;
  const fromEnv = typeof process !== "undefined" ? process.env.BUN_PUBLIC_BRIDGE_URL : undefined;
  return fromEnv ?? "http://localhost:4700";
}

export function makeBridgeClient(url: string = bridgeBaseUrl()): BridgeClient {
  return treaty<App>(url);
}

/**
 * WebSocket URL for a bridge path (e.g. `/workspaces/:repo/:name/terminal`).
 * Same-origin as {@link bridgeBaseUrl} — the fleet-client server proxies the
 * upgrade through to the real bridge — so `http(s)` just becomes `ws(s)`.
 */
export function wsBridgeUrl(path: string): string {
  return bridgeBaseUrl().replace(/^http/, "ws") + path;
}
