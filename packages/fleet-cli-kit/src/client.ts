import { treaty } from "@elysiajs/eden";
import type { App as BridgeApp } from "fleet-bridge/api";

export type FleetBridgeClient = ReturnType<typeof treaty<BridgeApp>>;

export function makeBridgeClient(url: string): FleetBridgeClient {
  return treaty<BridgeApp>(url);
}

/**
 * Normalize a URL option value into a full base URL.
 *
 * Accepts:
 *   - a bare port, e.g. "4700"           -> "http://localhost:4700"
 *   - a host:port, e.g. "localhost:4700" -> "http://localhost:4700"
 *   - a full URL, e.g. "http://foo:4700" -> unchanged
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

export interface EdenResult<T> {
  data: T | null;
  error: { status: number; value: unknown } | null;
}

/**
 * Unwrap an Eden Treaty response: return `data` on success, or print a clear
 * error message to stderr and exit the process with status 1. `program` prefixes
 * the message with the name of the CLI the caller ships as.
 */
export function unwrap<T>(result: EdenResult<T>, program: string): T {
  if (result.error) {
    const status = result.error.status;
    const value = result.error.value;
    const message =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    console.error(`${program}: request failed (${status}): ${message}`);
    process.exit(1);
  }

  if (result.data === null) {
    console.error(`${program}: request succeeded but returned no data`);
    process.exit(1);
  }

  return result.data;
}
