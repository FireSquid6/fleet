/**
 * config.ts — loads and validates the Fleet Ship configuration YAML.
 *
 * The shape is validated against `FleetShipConfigSchema` (a zod schema owned by
 * `fleet-protocol`); this loader only handles IO, YAML parsing, and resolving
 * `fleetDirectory` to an absolute path.
 */

import { resolve } from "node:path";
import { parse } from "yaml";
import { FleetShipConfigSchema, type FleetShipConfig } from "fleet-protocol";

/** Read, parse, and validate a `fleet-ship-config.yaml` at `path`. */
export async function loadConfig(path: string): Promise<FleetShipConfig> {
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

  // Validate the raw shape against the shared zod schema, then resolve the
  // workspace directory to an absolute path (relative to the current cwd).
  const config = FleetShipConfigSchema.parse(parsed);
  return { ...config, fleetDirectory: resolve(config.fleetDirectory) };
}
