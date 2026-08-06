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
  insecureNoAuth: z.boolean().optional(),
  /** How often to check ephemeral workspaces for a closed pull request; `0` never checks. */
  sweepIntervalMs: z.number().int().nonnegative().optional(),
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
  shipToken: z.string().min(1).optional(),
  bridgeToken: z.string().min(1).optional(),
});

const RemoteShipSchema = z.object({
  source: z.literal("remote"),
  url: z.string().min(1),
  shipToken: z.string().min(1).optional(),
  bridgeToken: z.string().min(1).optional(),
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
  insecureNoAuth?: boolean;
  sweepIntervalMs?: number;
}

export interface ShipTokens {
  shipToken?: string;
  bridgeToken?: string;
}

export interface NormalizedLocalShip extends ShipTokens {
  key: string;
  source: "local";
  fleetDirectory: string;
  port: number;
  name: string;
}

export interface NormalizedRemoteShip extends ShipTokens {
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

export type LaunchEnv = Record<string, string | undefined>;

const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function resolveSecret(value: string | undefined, where: string, env: LaunchEnv): string | undefined {
  if (value === undefined) return undefined;

  const match = ENV_REFERENCE.exec(value.trim());
  if (!match) {
    if (value.includes("${")) {
      throw new Error(
        `${where} contains "\${" but is not exactly one \${VAR} reference; ` +
          `write the whole value as \${VAR}, or as the literal secret`,
      );
    }
    return value;
  }

  const name = match[1]!;
  const resolved = env[name]?.trim();
  if (!resolved) {
    throw new Error(
      `${where} is \${${name}}, which is unset or empty in the environment; ` +
        `export ${name}, or delete the key to register this ship without credentials`,
    );
  }
  return resolved;
}

function shipTokens(key: string, ship: ShipTokens, env: LaunchEnv): ShipTokens {
  const shipToken = resolveSecret(ship.shipToken, `ships."${key}".shipToken`, env);
  const bridgeToken = resolveSecret(ship.bridgeToken, `ships."${key}".bridgeToken`, env);

  if ((shipToken === undefined) !== (bridgeToken === undefined)) {
    const [present, absent] = shipToken === undefined ? ["bridgeToken", "shipToken"] : ["shipToken", "bridgeToken"];
    throw new Error(
      `ship "${key}" sets ${present} but not ${absent}; ` +
        "a ship is registered with both a shipToken and a bridgeToken, or neither",
    );
  }
  return { shipToken, bridgeToken };
}

export function parseLaunchConfig(raw: unknown, deps?: { env?: LaunchEnv }): NormalizedLaunchConfig {
  const parsed = LaunchConfigSchema.parse(raw);
  const env = deps?.env ?? process.env;

  const ships: NormalizedShip[] = Object.entries(parsed.ships ?? {}).map(([key, ship]) => {
    const tokens = shipTokens(key, ship, env);
    if (ship.source === "remote") {
      return { key, source: "remote", url: ship.url, ...tokens };
    }
    return {
      key,
      source: "local",
      name: ship.name ?? key,
      fleetDirectory: resolve(ship.fleetDirectory ?? `./fleet/${key}`),
      port: ship.port,
      ...tokens,
    };
  });

  const localPorts = new Map<number, string>();
  const localNames = new Map<string, string>();
  for (const ship of ships) {
    if (ship.source !== "local") continue;
    const samePort = localPorts.get(ship.port);
    if (samePort) {
      throw new Error(
        `ships "${samePort}" and "${ship.key}" both use port ${ship.port}; give each local ship a distinct port`,
      );
    }
    localPorts.set(ship.port, ship.key);

    const sameName = localNames.get(ship.name);
    if (sameName) {
      throw new Error(
        `ships "${sameName}" and "${ship.key}" both use the name "${ship.name}"; give each local ship a distinct name`,
      );
    }
    localNames.set(ship.name, ship.key);
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
  # insecureNoAuth: true  # DEV ONLY: serve every route unauthenticated and skip creating the first admin

# The web gui. Proxies to the bridge above by default.
gui:
  port: 3000
  # bridgeUrl: http://localhost:4800  # defaults to the local bridge

# Ships that host workspaces. Each key is the ship's default name.
# A ship's shipToken/bridgeToken are set together or not at all, and \${VAR} reads
# the value from the environment so the secret never has to live in this file.
ships:
  ship-a:
    # source: local (the default) spawns the ship in this process.
    source: local
    fleetDirectory: ./fleet/ship-a
    port: 4700
    # name: ship-a  # defaults to the key above
    # shipToken: \${SHIP_A_SHIP_TOKEN}      # pin this ship's credentials instead of generating a fresh pair
    # bridgeToken: \${SHIP_A_BRIDGE_TOKEN}  # launch fails if a referenced variable is unset

  # source: remote registers an already-running ship by URL instead of spawning it.
  # ship-b:
  #   source: remote
  #   url: http://another-host:4700
  #   shipToken: \${SHIP_B_SHIP_TOKEN}      # the credentials that ship was already started with
  #   bridgeToken: \${SHIP_B_BRIDGE_TOKEN}  # must equal the ship's own FLEET_BRIDGE_TOKEN
`;

export async function loadLaunchConfig(
  path: string,
  deps?: { env?: LaunchEnv },
): Promise<NormalizedLaunchConfig> {
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

  return parseLaunchConfig(parsed, deps);
}
