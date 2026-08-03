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

export interface ShipRegistration {
  ship: NormalizedShip;
  url: string;
  alreadyRegistered: boolean;
}

/**
 * Decide, in config order, which ships the bridge still needs told about.
 *
 * The bridge dedupes on ship *name*, which a remote config entry never carries,
 * so the comparison has to happen on URL — normalized on both sides, since a
 * roster entry added over the HTTP API may carry a trailing slash. Ships are
 * marked registered as they are planned, so two entries sharing a URL yield one
 * registration.
 */
export function planRegistrations(
  ships: NormalizedShip[],
  registeredUrls: Iterable<string>,
): ShipRegistration[] {
  const registered = new Set([...registeredUrls].map(normalizeUrl));

  return ships.map((ship) => {
    const url = shipUrl(ship);
    const normalized = normalizeUrl(url);
    const alreadyRegistered = registered.has(normalized);
    registered.add(normalized);
    return { ship, url, alreadyRegistered };
  });
}

async function runLaunch(configPath: string): Promise<void> {
  const config = await loadLaunchConfig(configPath);

  const warning = publicUrlWarning(config);
  if (warning) {
    console.warn(`fleet launch: ${warning}`);
  }

  // A launch knows both sides, so it can pin each ship it spawns to the bridge
  // it just started rather than leaving it to trust whoever pushes first. The
  // value must be the one the bridge pushes with, not the one this process would
  // dial, hence `publicUrl` and the same fallback the bridge uses.
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
  // one of them. A ship needs no running bridge to start; its `bridgeUrl` is
  // only a pin, read from the config rather than from the started bridge.
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
    const plan = planRegistrations(
      config.ships,
      manager.listShips().map((info) => info.url),
    );
    for (const { ship, url, alreadyRegistered } of plan) {
      if (alreadyRegistered) {
        console.log(`ship "${ship.key}" (${url}) is already registered with the bridge`);
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
