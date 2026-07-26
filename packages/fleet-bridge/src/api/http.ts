/**
 * api/http.ts — shared HTTP error mapping for the bridge's Elysia plugins.
 *
 * Mirrors the ship's `mapError`: a `BridgeError` (or a provider-layer
 * `ProviderError`) carries the status to surface; anything else is a 500.
 */

import { BridgeError } from "../fleet-manager";
import { ProviderError } from "../providers";

export function mapError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof BridgeError || err instanceof ProviderError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}
