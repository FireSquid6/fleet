import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

export const FleetShipConfigSchema = z.object({
  /** Directory that holds all workspaces, laid out as `<fleetDirectory>/<repo>/<name>`. */
  fleetDirectory: z.string().min(1),
  port: z.number().int(),
  /** Human-facing name of this ship (surfaced as `ship` on active workspace status). */
  name: FleetIdentifierSchema,
  /**
   * The only bridge this ship accepts armory pushes from: a `POST /armory/sync`
   * naming any other origin is refused before anything is fetched. Left unset,
   * the ship pins whichever bridge pushes to it first and holds that from then
   * on, so a hand-started ship needs no extra flag.
   */
  bridgeUrl: z.url().optional(),
});

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
  port: z.number().int(),
});

export type Atlas = z.infer<typeof AtlasSchema>;
