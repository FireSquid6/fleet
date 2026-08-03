import { treaty } from "@elysiajs/eden";
import type { App as BridgeApp } from "fleet-bridge/api";

export type FleetBridgeClient = ReturnType<typeof treaty<BridgeApp>>;

export function makeBridgeClient(url: string, token?: string): FleetBridgeClient {
  return treaty<BridgeApp>(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
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

/** The human-readable part of an Eden error body, which may be any shape. */
export function edenErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") {
    return value.error;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Unwrap an Eden Treaty response: return `data` on success, or print a clear
 * error message to stderr and exit the process with status 1. `program` prefixes
 * the message with the name of the CLI the caller ships as.
 */
export function unwrap<T>(result: EdenResult<T>, program: string): T {
  if (result.error) {
    const status = result.error.status;
    console.error(`${program}: request failed (${status}): ${edenErrorMessage(result.error.value)}`);
    process.exit(1);
  }

  if (result.data === null) {
    console.error(`${program}: request succeeded but returned no data`);
    process.exit(1);
  }

  return result.data;
}
