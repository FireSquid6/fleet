
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { ARMORY_DIRECTORY } from "fleet-protocol";
import { type BridgeConfig, resolveBridgeConfig } from "./config";
import { FleetManager } from "./fleet-manager";
import { watchArmory, type ArmoryWatcher } from "./armory/armory-watcher";
import { createApp } from "./api";

export type { BridgeConfig } from "./config";

export const DEFAULT_BRIDGE_PORT = 4800;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port)) throw new InvalidArgumentError("must be an integer");
  return port;
}

/** Returns the manager so callers (e.g. `fleet launch`) can register more ships, and the watcher so they can close it. */
export async function startBridge(
  config: BridgeConfig,
): Promise<{ manager: FleetManager; watcher: ArmoryWatcher }> {
  // The store persists ships.json/repos.json here; create it up front so a
  // first run against a fresh (default) data directory can persist its roster.
  await mkdir(config.dataDirectory, { recursive: true });

  const manager = new FleetManager(config);

  const app = createApp(manager);
  app.listen(config.port);
  console.log(`fleet-bridge "${config.name}" listening on http://localhost:${config.port}`);

  try {
    await manager.init();
  } catch (error) {
    app.stop();
    manager.shutdown();
    throw error;
  }

  // Started after `init` — the ships that come online during it push themselves
  // through the connection's status handler.
  const watcher = watchArmory(join(config.dataDirectory, ARMORY_DIRECTORY), () => {
    manager.invalidateArmory();
    void manager.pushArmory();
  });

  return { manager, watcher };
}

export const bridge = new Command()
  .name("bridge")
  .description("start the Fleet Bridge HTTP + WebSocket API")
  .option("-p, --port <port>", "port the HTTP + WebSocket API listens on", parsePort, DEFAULT_BRIDGE_PORT)
  .option("-n, --name <name>", "human-facing name of this bridge", "bridge")
  .option("-d, --data-directory <dir>", "directory the bridge persists its ship roster to", "./.fleet-bridge")
  .option("--public-url <url>", "URL ships should use to reach this bridge")
  .action(async (options: { port: number; name: string; dataDirectory: string; publicUrl?: string }) => {
    try {
      const config = resolveBridgeConfig({
        dataDirectory: options.dataDirectory,
        port: options.port,
        name: options.name,
        publicUrl: options.publicUrl,
      });
      await startBridge(config);
    } catch (err) {
      console.error(`fleet-bridge: ${(err as Error).message}`);
      process.exit(1);
    }
  });
