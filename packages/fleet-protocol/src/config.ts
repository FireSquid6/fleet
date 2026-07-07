/**
 * src/config.ts — the Fleet Ship configuration contract.
 *
 * A ship is configured by a small YAML file (default `./fleet-ship-config.yaml`).
 * The canonical shape is the zod schema below; the host parses YAML then validates
 * it against `FleetShipConfigSchema`, and `FleetShipConfig` is inferred from it so
 * the type and the runtime validator can never drift.
 */

import { z } from "zod";

/** Runtime validator for a parsed `fleet-ship-config.yaml`. */
export const FleetShipConfigSchema = z.object({
  /** Directory that holds all workspaces, laid out as `<fleetDirectory>/<repo>/<name>`. */
  fleetDirectory: z.string().min(1),
  /** Port the ship's HTTP + WebSocket API listens on. */
  port: z.number().int(),
  /** Human-facing name of this ship (surfaced as `ship` on active workspace status). */
  name: z.string().min(1),
});

/** The parsed `fleet-ship-config.yaml`, inferred from the schema. */
export type FleetShipConfig = z.infer<typeof FleetShipConfigSchema>;

/**
 * Port the CLI falls back to when no `--url` is given (`http://localhost:${DEFAULT_PORT}`).
 * Ships are free to configure any port; this is only the client-side default.
 */
export const DEFAULT_PORT = 4700;
