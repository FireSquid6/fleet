import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { FleetIdentifierSchema } from "fleet-protocol";

const DEFAULT_BRIDGE_DATA_DIRECTORY = "./.fleet/bridge";
const DEFAULT_BRIDGE_PORT = 4800;
const DEFAULT_BRIDGE_NAME = "bridge";
const DEFAULT_SHIP_PORT = 4700;

const BridgeSectionSchema = z.object({
  dataDirectory: z.string().min(1).default(DEFAULT_BRIDGE_DATA_DIRECTORY),
  port: z.number().int().default(DEFAULT_BRIDGE_PORT),
  name: z.string().min(1).default(DEFAULT_BRIDGE_NAME),
  /**
   * URL *ships* use to reach this bridge — it is handed to each ship so it can
   * pull the armory, so it must resolve from the ships' hosts, not only from the
   * one running the launch. Omitted, the bridge falls back to
   * `http://localhost:<port>`, which is right for a single-host fleet and wrong
   * for any ship on another machine.
   */
  publicUrl: z.string().min(1).optional(),
});

const GuiSectionSchema = z.object({
  /** Port the gui listens on; if omitted, Bun picks one. */
  port: z.number().int().optional(),
  /** Bridge URL the gui proxies to; defaults to the launched local bridge. */
  bridgeUrl: z.string().min(1).optional(),
});

const LocalShipSchema = z.object({
  source: z.literal("local"),
  fleetDirectory: z.string().min(1).optional(),
  port: z.number().int().default(DEFAULT_SHIP_PORT),
  name: FleetIdentifierSchema.optional(),
});

const RemoteShipSchema = z.object({
  source: z.literal("remote"),
  url: z.string().min(1),
});

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
  publicUrl?: string;
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

/**
 * The warning a config earns by registering ships on other hosts without telling
 * them how to reach this bridge, or `null` when there is nothing to say.
 *
 * Deliberately not an error: a `source: remote` ship can be on this very host
 * (behind a tunnel, in a container publishing a port), where the
 * `http://localhost:<port>` fallback resolves fine. But when it is wrong it fails
 * silently — the ship is registered, workspaces work, and only the armory never
 * arrives — so it is worth saying out loud.
 */
export function publicUrlWarning(config: NormalizedLaunchConfig): string | null {
  if (!config.bridge || config.bridge.publicUrl) return null;

  const remote = config.ships.filter((ship) => ship.source === "remote");
  if (remote.length === 0) return null;

  const names = remote.map((ship) => `"${ship.key}"`).join(", ");
  return (
    `bridge.publicUrl is not set, so remote ${remote.length === 1 ? "ship" : "ships"} ${names} will be ` +
    `told this bridge is at http://localhost:${config.bridge.port}, which on their hosts is themselves; ` +
    `set bridge.publicUrl to a URL those hosts can reach`
  );
}

export const CONFIG_TEMPLATE = `# fleet-config.yaml — configuration for \`fleet launch\`.
# Every section is optional; only the sections present are started.

# The fleet-wide bridge that coordinates ships and serves the fleet API.
bridge:
  dataDirectory: ./.fleet/bridge
  port: 4800
  name: my-fleet-bridge
  # publicUrl: http://this-host:4800  # how ships reach this bridge; required if any ship is on another host

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
