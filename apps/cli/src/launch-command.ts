import { Command } from "commander";
import { startBridge } from "fleet-bridge";
import { startShip } from "fleet-ship";
import { startClientServer } from "fleet-client";
import { normalizeUrl } from "fleet-cli-kit";
import { CONFIG_TEMPLATE, loadLaunchConfig, publicUrlWarning } from "./launch-config";
import type { NormalizedShip } from "./launch-config";

const DEFAULT_CONFIG_PATH = "./fleet-config.yaml";

/** The URL the bridge reaches a configured ship at. */
export function shipUrl(ship: NormalizedShip): string {
  return ship.source === "local" ? `http://localhost:${ship.port}` : ship.url;
}

/** One ship on the bridge's roster, as `listShips()` reports it. */
export interface RosterEntry {
  name: string;
  url: string;
}

export type ShipRegistration = { ship: NormalizedShip; url: string } & (
  | { skip: null }
  | { skip: "on-bridge" }
  | { skip: "on-bridge-stale-url"; rosterUrl: string }
  | { skip: "duplicate-config-entry"; firstKey: string }
);

/**
 * Decide, in config order, which ships the bridge still needs told about.
 *
 * Matched with the bridge's own key wherever the config knows it. The bridge
 * dedupes on ship *name*, so a local entry — whose name `parseLaunchConfig`
 * always fills in — is matched by name and not by URL: matching it by URL would
 * both miss a ship whose port moved (`addShip` would then 409 on the name) and
 * suppress the adoption that teaches the bridge a renamed ship's real name. A
 * remote entry carries no name, so URL is all it can offer.
 *
 * URLs are normalized on both sides, since a roster entry added over the HTTP
 * API may carry a trailing slash.
 */
export function planRegistrations(
  ships: NormalizedShip[],
  roster: Iterable<RosterEntry>,
): ShipRegistration[] {
  const entries = [...roster];
  const rosterByName = new Map(entries.map((entry) => [entry.name, entry.url]));
  const rosterByUrl = new Map(entries.map((entry) => [normalizeUrl(entry.url), entry.url]));
  const claimedBy = new Map<string, string>();

  return ships.map((ship): ShipRegistration => {
    const url = shipUrl(ship);
    const normalized = normalizeUrl(url);

    const firstKey = claimedBy.get(normalized);
    if (firstKey !== undefined) return { ship, url, skip: "duplicate-config-entry", firstKey };
    claimedBy.set(normalized, ship.key);

    const rosterUrl =
      ship.source === "local" ? rosterByName.get(ship.name) : rosterByUrl.get(normalized);
    if (rosterUrl === undefined) return { ship, url, skip: null };

    return normalizeUrl(rosterUrl) === normalized
      ? { ship, url, skip: "on-bridge" }
      : { ship, url, skip: "on-bridge-stale-url", rosterUrl };
  });
}

async function runLaunch(configPath: string): Promise<void> {
  const config = await loadLaunchConfig(configPath);

  const warning = publicUrlWarning(config);
  if (warning) {
    console.warn(`fleet launch: ${warning}`);
  }

  // A launch knows both sides, so it can pin each ship it spawns to the bridge
  // this same config describes rather than leaving it to trust whoever pushes
  // first. The value must be the one the bridge pushes with, not the one this
  // process would dial, hence `publicUrl` and the same fallback the bridge uses.
  const launchedBridgeUrl = config.bridge
    ? (config.bridge.publicUrl ?? `http://localhost:${config.bridge.port}`)
    : undefined;
  if (launchedBridgeUrl && !isHttpUrl(launchedBridgeUrl)) {
    // A ship refuses a pin that is not an http(s) URL. Failing the whole launch
    // over a `bridge.publicUrl` that previously only broke the armory would be a
    // worse trade than starting unpinned and saying so.
    console.warn(
      `fleet launch: bridge.publicUrl "${launchedBridgeUrl}" is not an http(s) URL, so ships are ` +
        "started unpinned and will accept the first armory push they receive",
    );
  }
  const shipBridgeUrl = launchedBridgeUrl && isHttpUrl(launchedBridgeUrl) ? launchedBridgeUrl : undefined;

  // Ships come up before the bridge so that the roster the bridge restores from
  // disk during `init()` connects to live ships instead of timing out on every
  // one of them. Nothing below needs the bridge running: the pin above is read
  // from the config.
  for (const ship of config.ships) {
    if (ship.source !== "local") continue;
    await startShip({
      fleetDirectory: ship.fleetDirectory,
      port: ship.port,
      name: ship.name,
      bridgeUrl: shipBridgeUrl,
    });
  }

  let manager: Awaited<ReturnType<typeof startBridge>>["manager"] | undefined;
  if (config.bridge) {
    ({ manager } = await startBridge(config.bridge));
  }

  if (!manager) {
    for (const ship of config.ships) {
      console.log(`no bridge configured; not registering ship "${ship.key}" (${shipUrl(ship)})`);
    }
  } else {
    for (const entry of planRegistrations(config.ships, manager.listShips())) {
      const { ship, url } = entry;
      if (entry.skip === "duplicate-config-entry") {
        console.warn(
          `ships "${entry.firstKey}" and "${ship.key}" both point at ${url}; registering it once`,
        );
        continue;
      }
      if (entry.skip === "on-bridge") {
        console.log(`ship "${ship.key}" (${url}) is already registered with the bridge`);
        continue;
      }
      if (entry.skip === "on-bridge-stale-url") {
        console.warn(
          `ship "${ship.key}" is already registered with the bridge at ${entry.rosterUrl}, not ${url}`,
        );
        continue;
      }
      try {
        await manager.addShip(normalizeUrl(url));
        console.log(`registered ship "${ship.key}" (${url}) with the bridge`);
      } catch (err) {
        console.warn(`could not register ship "${ship.key}" (${url}): ${(err as Error).message}`);
      }
    }
  }

  if (config.gui) {
    // parseLaunchConfig guarantees a bridge exists when no explicit bridgeUrl is set.
    const bridgeUrl = config.gui.bridgeUrl ?? `http://localhost:${config.bridge!.port}`;
    startClientServer(normalizeUrl(bridgeUrl), config.gui.port);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function runInit(configPath: string, force: boolean): Promise<void> {
  const file = Bun.file(configPath);
  if (!force && (await file.exists())) {
    throw new Error(`refusing to overwrite existing ${configPath} (pass --force to replace it)`);
  }
  await Bun.write(configPath, CONFIG_TEMPLATE);
  console.log(`wrote ${configPath}`);
}

export const launchCommand = new Command()
  .name("launch")
  .description("launch a whole fleet (bridge + ships + gui) from a fleet-config.yaml")
  .option("--config-path <path>", "path to the fleet config yaml", DEFAULT_CONFIG_PATH)
  .action(async (options: { configPath: string }) => {
    try {
      await runLaunch(options.configPath);
    } catch (err) {
      console.error(`fleet launch: ${(err as Error).message}`);
      process.exit(1);
    }
  });

launchCommand
  .command("init")
  .description("scaffold a standard fleet-config.yaml")
  .option("--config-path <path>", "path to write the fleet config yaml", DEFAULT_CONFIG_PATH)
  .option("--force", "overwrite an existing config file")
  .action(async (options: { configPath: string; force?: boolean }) => {
    try {
      await runInit(options.configPath, options.force ?? false);
    } catch (err) {
      console.error(`fleet launch init: ${(err as Error).message}`);
      process.exit(1);
    }
  });
