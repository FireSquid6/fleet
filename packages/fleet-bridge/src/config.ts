/**
 * config.ts — loads and validates the Fleet Bridge configuration YAML.
 *
 * Mirrors `fleet-ship/src/config.ts`: this loader handles IO, YAML parsing, and
 * resolving `dataDirectory` to an absolute path. The shape is a small bridge-only
 * zod schema (the ship's config schema lives in the shared `fleet-protocol`
 * package; the bridge's is not shared, so it stays here).
 */

import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** Runtime validator for a parsed `fleet-bridge-config.yaml`. */
export const BridgeConfigSchema = z.object({
  /** Directory the bridge persists its ship roster (`ships.json`) to. */
  dataDirectory: z.string().min(1),
  /** Port the bridge's HTTP + WebSocket API listens on. */
  port: z.number().int(),
  /** Human-facing name of this bridge. */
  name: z.string().min(1),
});

/** The parsed `fleet-bridge-config.yaml`, inferred from the schema. */
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

/** Read, parse, and validate a `fleet-bridge-config.yaml` at `path`. */
export async function loadConfig(path: string): Promise<BridgeConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`config file not found: ${path}`);
  }

  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    throw new Error(`failed to parse config file ${path} as YAML: ${(err as Error).message}`);
  }

  const config = BridgeConfigSchema.parse(parsed);
  return { ...config, dataDirectory: resolve(config.dataDirectory) };
}
