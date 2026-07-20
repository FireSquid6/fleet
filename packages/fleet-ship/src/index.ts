import { Command } from "commander";
import { loadConfig } from "./config";
import { writeAtlas } from "./atlas";
import { installFleetSkill } from "./skill-installer";
import { installFleetPlugin } from "./plugin-installer";
import { pluginCommand } from "./plugin-command";

export const ship = new Command()
  .name("ship")
  .description("start the Fleet Ship HTTP + WebSocket API")
  .addCommand(pluginCommand)
  .option("-c, --config <path>", "path to the fleet-ship config yaml", "./fleet-ship-config.yaml")
  .action(async (options: { config: string }) => {
    // Deferred so merely mounting this subcommand in the unified CLI doesn't
    // eagerly pull in tmux-bun/webterm. They're only needed when the ship
    // actually runs.
    const { WorkspaceManager } = await import("./workspace-manager");
    const { createApp } = await import("./api");

    const config = await loadConfig(options.config);
    await installFleetSkill();
    await installFleetPlugin();
    const manager = new WorkspaceManager(config);
    const app = createApp(manager, config);
    app.listen(config.port);

    // Publish the discovery file so agents inside workspaces can reach us.
    await writeAtlas(config.fleetDirectory, { port: app.server?.port ?? config.port });

    console.log(`fleet-ship "${config.name}" listening on http://localhost:${config.port}`);
  });

