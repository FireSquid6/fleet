import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { FleetShipConfigSchema, type FleetShipConfig } from "fleet-protocol";

export const BRIDGE_TOKEN_ENV_VAR = "FLEET_BRIDGE_TOKEN";

export function resolveFleetShipConfig(raw: unknown): FleetShipConfig {
  const config = FleetShipConfigSchema.parse(raw);
  return { ...config, fleetDirectory: resolve(config.fleetDirectory) };
}

export function resolveBridgeToken(
  configured: string | undefined,
  deps?: { env?: Record<string, string | undefined> },
): string | undefined {
  const token = configured ?? (deps?.env ?? process.env)[BRIDGE_TOKEN_ENV_VAR];
  return token === undefined || token.length === 0 ? undefined : token;
}

export async function canonicalizeFleetDirectory(config: FleetShipConfig): Promise<FleetShipConfig> {
  await mkdir(config.fleetDirectory, { recursive: true });
  return { ...config, fleetDirectory: await realpath(config.fleetDirectory) };
}
