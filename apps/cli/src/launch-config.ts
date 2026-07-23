/**
 * launch-config.ts — the `fleet launch` configuration contract.
 *
 * `fleet launch` reads a single `fleet-config.yaml` describing a whole fleet:
 * an optional `bridge`, an optional `gui`, and an optional map of `ships`. This
 * module owns the zod schema, the YAML loader, and the normalization step that
 * fills per-field defaults (a ship's `name`/`fleetDirectory` default from its
 * map key) and validates cross-section constraints (unique local ports, a gui
 * always has a bridge to reach).
 */

import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { FleetIdentifierSchema } from "fleet-protocol";

/** Default bridge dataDirectory when the `bridge` section omits it. */
const DEFAULT_BRIDGE_DATA_DIRECTORY = "./.fleet/bridge";
const DEFAULT_BRIDGE_PORT = 4800;
const DEFAULT_BRIDGE_NAME = "bridge";
const DEFAULT_SHIP_PORT = 4700;

const BridgeSectionSchema = z.object({
  dataDirectory: z.string().min(1).default(DEFAULT_BRIDGE_DATA_DIRECTORY),
  port: z.number().int().default(DEFAULT_BRIDGE_PORT),
  name: z.string().min(1).default(DEFAULT_BRIDGE_NAME),
});

const GuiSectionSchema = z.object({
  /** Port the gui listens on; if omitted, Bun picks one. */
  port: z.number().int().optional(),
  /** Bridge URL the gui proxies to; defaults to the launched local bridge. */
  bridgeUrl: z.string().min(1).optional(),
});

/** A ship the launch spawns itself (`source: local`, the default). */
const LocalShipSchema = z.object({
  source: z.literal("local"),
  fleetDirectory: z.string().min(1).optional(),
  port: z.number().int().default(DEFAULT_SHIP_PORT),
  name: FleetIdentifierSchema.optional(),
});

/** A ship already running elsewhere, registered by URL (`source: remote`). */
const RemoteShipSchema = z.object({
  source: z.literal("remote"),
  url: z.string().min(1),
});

/** A ship entry — `source` defaults to `local` when omitted. */
const ShipSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value) && !("source" in value)
      ? { ...value, source: "local" }
      : value,
  z.discriminatedUnion("source", [LocalShipSchema, RemoteShipSchema]),
);

export const LaunchConfigSchema = z.preprocess(
  (raw) => {
    // A bare `bridge:`/`gui:` key (no body) parses to null; treat it as "enabled
    // with defaults" rather than a validation error.
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const object = { ...(raw as Record<string, unknown>) };
      if (object.bridge === null) object.bridge = {};
      if (object.gui === null) object.gui = {};
      return object;
    }
    return raw;
  },
  z.object({
    bridge: BridgeSectionSchema.optional(),
    gui: GuiSectionSchema.optional(),
    ships: z.record(z.string(), ShipSchema).optional(),
  }),
);

export interface NormalizedBridge {
  dataDirectory: string;
  port: number;
  name: string;
}

export interface NormalizedLocalShip {
  key: string;
  source: "local";
  fleetDirectory: string;
  port: number;
  name: string;
}

export interface NormalizedRemoteShip {
  key: string;
  source: "remote";
  url: string;
}

export type NormalizedShip = NormalizedLocalShip | NormalizedRemoteShip;

export interface NormalizedLaunchConfig {
  bridge?: NormalizedBridge;
  gui?: { port?: number; bridgeUrl?: string };
  ships: NormalizedShip[];
}

/**
 * Validate and normalize a raw (already YAML-parsed) launch config: fill
 * key-derived ship defaults, resolve `fleetDirectory` to an absolute path, and
 * enforce cross-section constraints. Pure — no IO — so it's directly testable.
 */
export function parseLaunchConfig(raw: unknown): NormalizedLaunchConfig {
  const parsed = LaunchConfigSchema.parse(raw);

  const ships: NormalizedShip[] = Object.entries(parsed.ships ?? {}).map(([key, ship]) => {
    if (ship.source === "remote") {
      return { key, source: "remote", url: ship.url };
    }
    return {
      key,
      source: "local",
      name: ship.name ?? key,
      fleetDirectory: resolve(ship.fleetDirectory ?? `./fleet/${key}`),
      port: ship.port,
    };
  });

  const localPorts = new Map<number, string>();
  for (const ship of ships) {
    if (ship.source !== "local") continue;
    const existing = localPorts.get(ship.port);
    if (existing) {
      throw new Error(
        `ships "${existing}" and "${ship.key}" both use port ${ship.port}; give each local ship a distinct port`,
      );
    }
    localPorts.set(ship.port, ship.key);
  }

  if (parsed.gui && !parsed.bridge && !parsed.gui.bridgeUrl) {
    throw new Error("gui is configured with no bridge to proxy to; add a bridge section or gui.bridgeUrl");
  }

  const bridge = parsed.bridge
    ? { ...parsed.bridge, dataDirectory: resolve(parsed.bridge.dataDirectory) }
    : undefined;

  return { bridge, gui: parsed.gui, ships };
}

/** Standard scaffold written by `fleet launch init` (commented for humans to edit). */
export const CONFIG_TEMPLATE = `# fleet-config.yaml — configuration for \`fleet launch\`.
# Every section is optional; only the sections present are started.

# The fleet-wide bridge that coordinates ships and serves the fleet API.
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: my-fleet-bridge

# The web gui. Proxies to the bridge above by default.
gui:
  port: 3000
  # bridgeUrl: http://localhost:4800  # defaults to the local bridge

# Ships that host workspaces. Each key is the ship's default name.
ships:
  ship-a:
    # source: local (the default) spawns the ship in this process.
    source: local
    fleetDirectory: ./fleet/ship-a
    port: 4700
    # name: ship-a  # defaults to the key above

  # source: remote registers an already-running ship by URL instead of spawning it.
  # ship-b:
  #   source: remote
  #   url: http://another-host:4700
`;

/** Read, parse, and normalize a `fleet-config.yaml` at `path`. */
export async function loadLaunchConfig(path: string): Promise<NormalizedLaunchConfig> {
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

  return parseLaunchConfig(parsed);
}
