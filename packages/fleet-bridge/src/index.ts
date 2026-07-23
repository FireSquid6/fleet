
import { mkdir } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { type BridgeConfig, resolveBridgeConfig } from "./config";
import { FleetManager } from "./fleet-manager";
import { createApp } from "./api";

export type { BridgeConfig } from "./config";

/** Default port the bridge's HTTP + WebSocket API listens on. */
export const DEFAULT_BRIDGE_PORT = 4800;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port)) throw new InvalidArgumentError("must be an integer");
  return port;
}

/**
 * Bring up a bridge: init the manager (loads the persisted ship roster and
 * connects to each ship), then serve the API. Returns the manager so callers
 * (e.g. `fleet launch`) can register additional ships. Throws on failure.
 */
export async function startBridge(config: BridgeConfig): Promise<{ manager: FleetManager }> {
  // The store persists ships.json/repos.json here; create it up front so a
  // first run against a fresh (default) data directory can persist its roster.
  await mkdir(config.dataDirectory, { recursive: true });

  const manager = new FleetManager(config);
  await manager.init();

  const app = createApp(manager, config);
  app.listen(config.port);
  console.log(`fleet-bridge "${config.name}" listening on http://localhost:${config.port}`);
  return { manager };
}

export const bridge = new Command()
  .name("bridge")
  .description("start the Fleet Bridge HTTP + WebSocket API")
  .option("-p, --port <port>", "port the HTTP + WebSocket API listens on", parsePort, DEFAULT_BRIDGE_PORT)
  .option("-n, --name <name>", "human-facing name of this bridge", "bridge")
  .option("-d, --data-directory <dir>", "directory the bridge persists its ship roster to", "./.fleet-bridge")
  .action(async (options: { port: number; name: string; dataDirectory: string }) => {
    try {
      const config = resolveBridgeConfig({
        dataDirectory: options.dataDirectory,
        port: options.port,
        name: options.name,
      });
      await startBridge(config);
    } catch (err) {
      console.error(`fleet-bridge: ${(err as Error).message}`);
      process.exit(1);
    }
  });
