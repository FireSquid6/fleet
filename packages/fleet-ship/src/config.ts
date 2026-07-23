/**
 * config.ts — resolves and canonicalizes the Fleet Ship configuration.
 *
 * A ship is configured from CLI flags (see `index.ts`); this file validates a
 * flag-assembled object against the shared `FleetShipConfigSchema` (owned by
 * `fleet-protocol`) and handles resolving/canonicalizing `fleetDirectory`.
 */

import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { FleetShipConfigSchema, type FleetShipConfig } from "fleet-protocol";

/** Validate a raw (flag-assembled) config, resolving `fleetDirectory` to an absolute path. */
export function resolveFleetShipConfig(raw: unknown): FleetShipConfig {
  const config = FleetShipConfigSchema.parse(raw);
  return { ...config, fleetDirectory: resolve(config.fleetDirectory) };
}

export async function canonicalizeFleetDirectory(config: FleetShipConfig): Promise<FleetShipConfig> {
  await mkdir(config.fleetDirectory, { recursive: true });
  return { ...config, fleetDirectory: await realpath(config.fleetDirectory) };
}
