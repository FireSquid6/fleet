import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { FleetShipConfigSchema, type FleetShipConfig } from "fleet-protocol";

export function resolveFleetShipConfig(raw: unknown): FleetShipConfig {
  const config = FleetShipConfigSchema.parse(raw);
  return { ...config, fleetDirectory: resolve(config.fleetDirectory) };
}

export async function canonicalizeFleetDirectory(config: FleetShipConfig): Promise<FleetShipConfig> {
  await mkdir(config.fleetDirectory, { recursive: true });
  return { ...config, fleetDirectory: await realpath(config.fleetDirectory) };
}
