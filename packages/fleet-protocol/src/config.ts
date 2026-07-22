/**
 * src/config.ts — the Fleet Ship configuration contract.
 *
 * A ship is configured by a small YAML file (default `./fleet-ship-config.yaml`).
 * The canonical shape is the zod schema below; the host parses YAML then validates
 * it against `FleetShipConfigSchema`, and `FleetShipConfig` is inferred from it so
 * the type and the runtime validator can never drift.
 */

import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

/** Runtime validator for a parsed `fleet-ship-config.yaml`. */
export const FleetShipConfigSchema = z.object({
  /** Directory that holds all workspaces, laid out as `<fleetDirectory>/<repo>/<name>`. */
  fleetDirectory: z.string().min(1),
  /** Port the ship's HTTP + WebSocket API listens on. */
  port: z.number().int(),
  /** Human-facing name of this ship (surfaced as `ship` on active workspace status). */
  name: FleetIdentifierSchema,
  /**
   * Shared secret required (as `Authorization: Bearer <token>`) on every request,
   * including WebSockets. Only the bridge and CLI reach a ship, and both present it.
   * Usually supplied via `FLEET_SERVICE_TOKEN` rather than YAML; when unset the ship
   * runs unauthenticated (rollout compatibility).
   */
  serviceToken: z.string().min(1).optional(),
});

/** The parsed `fleet-ship-config.yaml`, inferred from the schema. */
export type FleetShipConfig = z.infer<typeof FleetShipConfigSchema>;

/**
 * Port the CLI falls back to when no `--url` is given (`http://localhost:${DEFAULT_PORT}`).
 * Ships are free to configure any port; this is only the client-side default.
 */
export const DEFAULT_PORT = 4700;

/**
 * Name of the discovery file the ship writes to the root of its `fleetDirectory`
 * on startup. An agent inside a workspace (`<fleetDirectory>/<repo>/<name>`) can
 * walk up to the data-directory root to find it and learn how to reach the ship.
 */
export const ATLAS_FILENAME = "atlas.json";

/** Contents of `atlas.json` — how a workspace-local agent reaches its ship. */
export const AtlasSchema = z.object({
  /** Local port the ship's HTTP + WebSocket API is listening on. */
  port: z.number().int(),
});

/** The parsed `atlas.json`, inferred from the schema. */
export type Atlas = z.infer<typeof AtlasSchema>;
