import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_PORT, type FleetShipConfig } from "fleet-protocol";
import { canonicalizeFleetDirectory, resolveFleetShipConfig } from "./config";
import { writeAtlas } from "./atlas";
import { installFleetSkill } from "./skill-installer";
import { installFleetPlugin } from "./plugin-installer";
import { pluginCommand } from "./plugin-command";

export async function installStartupIntegrations(options: {
  homeDirectory?: string;
  skillSourcePath?: string;
  pluginsDirectory?: string;
  installers?: {
    skill: typeof installFleetSkill;
    plugin: typeof installFleetPlugin;
  };
} = {}): Promise<void> {
  const installers = options.installers ?? {
    skill: installFleetSkill,
    plugin: installFleetPlugin,
  };
  let skills: Awaited<ReturnType<typeof installFleetSkill>> = [];
  let plugins: Awaited<ReturnType<typeof installFleetPlugin>> = [];
  try {
    skills = await installers.skill({
      homeDirectory: options.homeDirectory,
      sourcePath: options.skillSourcePath,
    });
  } catch (error) {
    console.warn(
      `Fleet startup could not install agent skills: ${formatInstallerError(error)}. ` +
        "Fix the reported path, then run fleet ship plugin install all.",
    );
  }
  try {
    plugins = await installers.plugin({
      homeDirectory: options.homeDirectory,
      pluginsDirectory: options.pluginsDirectory,
    });
  } catch (error) {
    console.warn(
      `Fleet startup could not install startup plugins: ${formatInstallerError(error)}. ` +
        "Fix the reported path, then run fleet ship plugin install all.",
    );
  }
  const conflicts = [
    ...skills
      .filter(({ status }) => status === "conflict")
      .map(({ provider, path }) => ({ provider, path })),
    ...plugins.flatMap(({ provider, conflictPaths }) =>
      (conflictPaths ?? []).map((path) => ({ provider, path })),
    ),
  ];
  for (const { provider, path } of conflicts) {
    console.warn(
      `Fleet startup preserved conflicting ${provider} integration file: ${path}. ` +
        `Run fleet ship plugin install ${provider} --force to replace it.`,
    );
  }
}

function formatInstallerError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages: string[] = [error.message];
  if (error instanceof AggregateError) {
    for (const failure of error.errors) {
      if (failure instanceof Error) {
        messages.push(failure.message);
        if (failure.cause instanceof Error) messages.push(failure.cause.message);
      }
    }
  } else if (error.cause instanceof Error) {
    messages.push(error.cause.message);
  }
  return [...new Set(messages)].join(": ");
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port)) throw new InvalidArgumentError("must be an integer");
  return port;
}

/**
 * Bring up a ship: canonicalize its fleet directory, install agent integrations,
 * serve the API, and publish the `atlas.json` discovery file. Throws on failure.
 */
export async function startShip(config: FleetShipConfig): Promise<void> {
  // Deferred so merely mounting this subcommand in the unified CLI doesn't
  // eagerly pull in tmux-bun/webterm. They're only needed when the ship
  // actually runs.
  const { WorkspaceManager } = await import("./workspace-manager");
  const { createApp } = await import("./api");

  const canonical = await canonicalizeFleetDirectory(config);
  await installStartupIntegrations();
  const manager = new WorkspaceManager(canonical);
  const app = createApp(manager, canonical);
  app.listen(canonical.port);

  // Publish the discovery file so agents inside workspaces can reach us.
  await writeAtlas(canonical.fleetDirectory, { port: app.server?.port ?? canonical.port });

  console.log(`fleet-ship "${canonical.name}" listening on http://localhost:${canonical.port}`);
}

export const ship = new Command()
  .name("ship")
  .description("start the Fleet Ship HTTP + WebSocket API")
  .addCommand(pluginCommand)
  .option("-p, --port <port>", "port the HTTP + WebSocket API listens on", parsePort, DEFAULT_PORT)
  .option("-n, --name <name>", "human-facing name of this ship", "ship")
  .option("-f, --fleet-directory <dir>", "directory holding all workspaces (<dir>/<repo>/<name>)", "./fleet")
  .action(async (options: { port: number; name: string; fleetDirectory: string }) => {
    try {
      const config = resolveFleetShipConfig({
        fleetDirectory: options.fleetDirectory,
        port: options.port,
        name: options.name,
      });
      await startShip(config);
    } catch (err) {
      console.error(`fleet-ship: ${(err as Error).message}`);
      process.exit(1);
    }
  });
