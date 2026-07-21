/**
 * client.ts — the Eden Treaty client the CLI uses to talk to a Fleet Ship
 * host, plus small helpers for normalizing the `--url` option and unwrapping
 * Eden's `{ data, error }` result shape.
 */

import { treaty } from "@elysiajs/eden";
import type { App } from "fleet-ship/api";

export type FleetClient = ReturnType<typeof treaty<App>>;

/** Build an Eden Treaty client pointed at `url` (already normalized). */
export function makeClient(url: string): FleetClient {
  return treaty<App>(url);
}

/**
 * Normalize a `--url` value into a full base URL.
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
    console.error(`fleet: request failed (${status}): ${message}`);
    process.exit(1);
  }

  if (result.data === null) {
    console.error("fleet: request succeeded but returned no data");
    process.exit(1);
  }

  return result.data;
}
