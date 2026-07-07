/**
 * config.ts — loads and validates the Fleet Ship configuration YAML.
 */

import { resolve } from "node:path";
import { parse } from "yaml";
import type { FleetShipConfig } from "fleet-protocol";

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

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must contain a YAML mapping`);
  }

  const obj = parsed as Record<string, unknown>;

  const fleetDirectory = obj["fleetDirectory"];
  if (typeof fleetDirectory !== "string" || fleetDirectory.length === 0) {
    throw new Error(`config file ${path}: "fleetDirectory" must be a non-empty string`);
  }

  const port = obj["port"];
  if (typeof port !== "number" || !Number.isInteger(port)) {
    throw new Error(`config file ${path}: "port" must be a number`);
  }

  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`config file ${path}: "name" must be a non-empty string`);
  }

  return {
    fleetDirectory: resolve(fleetDirectory),
    port,
    name,
  };
}
