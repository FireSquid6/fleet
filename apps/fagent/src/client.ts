/**
 * client.ts — the Eden Treaty client fagent uses to talk to a Fleet Bridge,
 * plus small helpers for normalizing the `--bridge-url` option and unwrapping
 * Eden's `{ data, error }` result shape. fagent only ever reaches the bridge
 * (never a ship, never GitHub directly), so this is the bridge client only.
 */

import { treaty } from "@elysiajs/eden";
import type { App as BridgeApp } from "fleet-bridge/api";

export type FleetBridgeClient = ReturnType<typeof treaty<BridgeApp>>;

/** Build an Eden Treaty client pointed at a Fleet Bridge `url` (already normalized). */
export function makeBridgeClient(url: string): FleetBridgeClient {
  return treaty<BridgeApp>(url);
}

/**
 * Normalize a `--bridge-url` value into a full base URL.
 *
 * Accepts:
 *   - a bare port, e.g. "4800"           -> "http://localhost:4800"
 *   - a host:port, e.g. "localhost:4800" -> "http://localhost:4800"
 *   - a full URL, e.g. "http://foo:4800" -> unchanged
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^\d+$/.test(trimmed)) {
    return `http://localhost:${trimmed}`;
  }

  return `http://${trimmed}`;
}

/** Shape every Eden Treaty call resolves to. */
export interface EdenResult<T> {
  data: T | null;
  error: { status: number; value: unknown } | null;
}

/**
 * Unwrap an Eden Treaty response: return `data` on success, or print a clear
 * error message to stderr and exit the process with status 1.
 */
export function unwrap<T>(result: EdenResult<T>): T {
  if (result.error) {
    const status = result.error.status;
    const value = result.error.value;
    const message =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    console.error(`fagent: request failed (${status}): ${message}`);
    process.exit(1);
  }

  if (result.data === null) {
    console.error("fagent: request succeeded but returned no data");
    process.exit(1);
  }

  return result.data;
}
