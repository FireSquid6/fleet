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
import { CONFIG_TEMPLATE, loadLaunchConfig } from "./launch-config";

const DEFAULT_CONFIG_PATH = "./fleet-config.yaml";

async function runLaunch(configPath: string): Promise<void> {
  const config = await loadLaunchConfig(configPath);

  let manager: Awaited<ReturnType<typeof startBridge>>["manager"] | undefined;
  if (config.bridge) {
    ({ manager } = await startBridge(config.bridge));
  }

  for (const ship of config.ships) {
    if (ship.source === "local") {
      await startShip({ fleetDirectory: ship.fleetDirectory, port: ship.port, name: ship.name });
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
