/**
 * config.ts — the Fleet Bridge configuration contract.
 *
 * The bridge is configured entirely from CLI flags (see `index.ts`); this file
 * owns the canonical shape (`BridgeConfigSchema`) and validates a flag-assembled
 * object against it, resolving `dataDirectory` to an absolute path. The shape is
 * a small bridge-only zod schema (the ship's config schema lives in the shared
 * `fleet-protocol` package; the bridge's is not shared, so it stays here).
 */

import { resolve } from "node:path";
import { z } from "zod";

/** Runtime validator for the bridge configuration. */
export const BridgeConfigSchema = z.object({
  /** Directory the bridge persists its ship roster (`ships.json`) to. */
  dataDirectory: z.string().min(1),
  /** Port the bridge's HTTP + WebSocket API listens on. */
  port: z.number().int(),
  /** Human-facing name of this bridge. */
  name: z.string().min(1),
});

/** The bridge configuration, inferred from the schema. */
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

/** Validate a raw (flag-assembled) config, resolving `dataDirectory` to an absolute path. */
export function resolveBridgeConfig(raw: unknown): BridgeConfig {
  const config = BridgeConfigSchema.parse(raw);
  return { ...config, dataDirectory: resolve(config.dataDirectory) };
}
