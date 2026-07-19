/**
 * api/index.ts — composes the bridge's Elysia app from its two plugins.
 *
 * Both plugins are single Elysia chains, so `.use()` merges their route types
 * into the parent and `App = ReturnType<typeof createApp>` carries the full
 * merged surface for a future Eden `treaty<App>` client.
 */

import { Elysia } from "elysia";
import type { FleetManager } from "../fleet-manager";
import type { BridgeConfig } from "../config";
import { workspacesPlugin } from "./workspaces";
import { shipsPlugin } from "./ships";
import { systemResourcesPlugin } from "./system-resources";
import { reposPlugin } from "./repos";

export function createApp(manager: FleetManager, _config: BridgeConfig) {
  return new Elysia()
    .use(workspacesPlugin(manager))
    .use(shipsPlugin(manager))
    .use(systemResourcesPlugin(manager))
    .use(reposPlugin(manager));
}

export type App = ReturnType<typeof createApp>;
