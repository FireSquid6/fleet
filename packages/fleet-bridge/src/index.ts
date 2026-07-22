
import { Command } from "commander";
import { DEFAULT_SESSION_TTL_MS, loadConfig } from "./config";
import { FleetManager } from "./fleet-manager";
import { AuthService } from "./auth-service";
import { Store } from "./store/store";
import { createApp } from "./api";

export const bridge = new Command()
  .name("bridge")
  .description("start the Fleet Bridge HTTP + WebSocket API")
  .option("-c, --config <path>", "path to the fleet-bridge config yaml", "./fleet-bridge-config.yaml")
  .action(async (options: { config: string }) => {
    const config = await loadConfig(options.config);

    // One shared Store backs both the fleet roster and the auth collections.
    const store = new Store(config.dataDirectory);
    await store.load();
    const manager = new FleetManager(config, undefined, { store });
    const auth = new AuthService(store, { sessionTtlMs: config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS });

    try {
      await manager.init();
    } catch (err) {
      console.error(`fleet-bridge: ${(err as Error).message}`);
      process.exit(1);
    }

    const app = createApp(manager, config, auth);
    app.listen(config.port);
    console.log(`fleet-bridge "${config.name}" listening on http://localhost:${config.port}`);
  });

bridge
  .command("create-user")
  .description("create a local user account for the web UI")
  .argument("<username>", "the username to create")
  .option("-c, --config <path>", "path to the fleet-bridge config yaml", "./fleet-bridge-config.yaml")
  .option("-p, --password <password>", "the password (prompted for if omitted)")
  .action(async (username: string, options: { config: string; password?: string }) => {
    const config = await loadConfig(options.config);
    const store = new Store(config.dataDirectory);
    await store.load();
    const auth = new AuthService(store, { sessionTtlMs: config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS });

    const password = options.password ?? prompt(`Password for "${username}": `) ?? "";
    if (!password) {
      console.error("fleet-bridge: a password is required");
      process.exit(1);
    }

    try {
      await auth.createUser(username, password);
      console.log(`fleet-bridge: created user "${username}"`);
    } catch (err) {
      console.error(`fleet-bridge: ${(err as Error).message}`);
      process.exit(1);
    }
  });
