/**
 * launch-command.ts — `fleet launch` and `fleet launch init`.
 *
 * `fleet launch` brings a whole fleet up in one process from a `fleet-config.yaml`
 * (bridge + ships + gui), auto-registering each ship with the bridge. `fleet
 * launch init` scaffolds a standard, commented config.
 */

import { Command } from "commander";
import { startBridge } from "fleet-bridge";
import { startShip } from "fleet-ship";
import { startClientServer } from "fleet-client";
import { normalizeUrl } from "./client";
import { CONFIG_TEMPLATE, loadLaunchConfig, publicUrlWarning } from "./launch-config";

const DEFAULT_CONFIG_PATH = "./fleet-config.yaml";

async function runLaunch(configPath: string): Promise<void> {
  const config = await loadLaunchConfig(configPath);

  const warning = publicUrlWarning(config);
  if (warning) {
    console.warn(`fleet launch: ${warning}`);
  }

  let manager: Awaited<ReturnType<typeof startBridge>>["manager"] | undefined;
  if (config.bridge) {
    ({ manager } = await startBridge(config.bridge));
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

  for (const ship of config.ships) {
    if (ship.source === "local") {
      await startShip({
        fleetDirectory: ship.fleetDirectory,
        port: ship.port,
        name: ship.name,
        bridgeUrl: shipBridgeUrl,
      });
    }

    const url = ship.source === "local" ? `http://localhost:${ship.port}` : ship.url;
    if (!manager) {
      console.log(`no bridge configured; not registering ship "${ship.key}" (${url})`);
      continue;
    }
    try {
      await manager.addShip(normalizeUrl(url));
      console.log(`registered ship "${ship.key}" (${url}) with the bridge`);
    } catch (err) {
      console.warn(`could not register ship "${ship.key}" (${url}): ${(err as Error).message}`);
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
