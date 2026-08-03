
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { ARMORY_DIRECTORY } from "fleet-protocol";
import { type BridgeConfig, resolveBridgeConfig } from "./config";
import { FleetManager } from "./fleet-manager";
import { watchArmory, type ArmoryWatcher } from "./armory/armory-watcher";
import { createApp } from "./api";
import { AuthDatabase } from "./auth/auth-database";
import { AuthService } from "./auth/auth-service";
import { ensureFirstUser } from "./auth/bootstrap";

export type { BridgeConfig } from "./config";

export const DEFAULT_BRIDGE_PORT = 4800;

const INSECURE_BANNER = [
  "",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "!!  AUTHENTICATION IS DISABLED  (--insecure-no-auth)",
  "!!",
  "!!  Every route on this bridge answers any client that can reach",
  "!!  it, on every address it is listening on. Anyone on your network",
  "!!  can read and control this fleet.",
  "!!",
  "!!  Local development only.",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "",
].join("\n");

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port)) throw new InvalidArgumentError("must be an integer");
  return port;
}

/**
 * Returns the manager so callers (e.g. `fleet launch`) can register more ships,
 * the watcher so they can close it, and the auth service so they can mint
 * credentials for the ships they add.
 */
export async function startBridge(
  config: BridgeConfig,
): Promise<{ manager: FleetManager; watcher: ArmoryWatcher; auth: AuthService }> {
  // The store persists ships.json/repos.json here; create it up front so a
  // first run against a fresh (default) data directory can persist its roster.
  await mkdir(config.dataDirectory, { recursive: true });

  const authDatabase = new AuthDatabase(join(config.dataDirectory, "auth.db"));
  authDatabase.migrate();
  authDatabase.deleteExpiredSessions(Date.now());
  const auth = new AuthService(authDatabase);
  // Before anything long-running: this may prompt, and a laptop user should not
  // have to read past ship-connection logs to find the question.
  if (!config.insecureNoAuth) await ensureFirstUser(auth);

  const manager = new FleetManager(config);
  await manager.init();

  // Started after `init` — the ships that come online during it push themselves
  // through the connection's status handler.
  const watcher = watchArmory(join(config.dataDirectory, ARMORY_DIRECTORY), () => {
    manager.invalidateArmory();
    void manager.pushArmory();
  });

  const app = createApp(manager, auth);
  app.listen(config.port);
  console.log(`fleet-bridge "${config.name}" listening on http://localhost:${config.port}`);
  if (config.insecureNoAuth) console.error(INSECURE_BANNER);
  return { manager, watcher, auth };
}

export const bridge = new Command()
  .name("bridge")
  .description("start the Fleet Bridge HTTP + WebSocket API")
  .option("-p, --port <port>", "port the HTTP + WebSocket API listens on", parsePort, DEFAULT_BRIDGE_PORT)
  .option("-n, --name <name>", "human-facing name of this bridge", "bridge")
  .option("-d, --data-directory <dir>", "directory the bridge persists its ship roster to", "./.fleet-bridge")
  .option("--public-url <url>", "URL ships should use to reach this bridge")
  .option("--insecure-no-auth", "development only: serve every route without authentication")
  .action(async (options: {
    port: number;
    name: string;
    dataDirectory: string;
    publicUrl?: string;
    insecureNoAuth?: boolean;
  }) => {
    try {
      const config = resolveBridgeConfig({
        dataDirectory: options.dataDirectory,
        port: options.port,
        name: options.name,
        publicUrl: options.publicUrl,
        insecureNoAuth: options.insecureNoAuth ?? false,
      });
      await startBridge(config);
    } catch (err) {
      console.error(`fleet-bridge: ${(err as Error).message}`);
      process.exit(1);
    }
  });
