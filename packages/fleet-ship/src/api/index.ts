/**
 * api/index.ts — composes the ship's Elysia app from its two plugins.
 *
 * Both plugins are single Elysia chains, so `.use()` merges their route types
 * into the parent and `App = ReturnType<typeof createApp>` carries the full
 * merged surface for the CLI's Eden `treaty<App>` client.
 */

import { Elysia } from "elysia";
import type { WorkspaceManager } from "../workspace-manager";
import type { FleetShipConfig } from "fleet-protocol";
import { workspacesPlugin } from "./workspaces";
import { eventsPlugin } from "./events";
import { systemResourcesPlugin } from "./system-resources";

export function createApp(manager: WorkspaceManager, _config: FleetShipConfig) {
  return new Elysia()
    .use(workspacesPlugin(manager))
    .use(eventsPlugin(manager))
    .use(systemResourcesPlugin());
}

export type App = ReturnType<typeof createApp>;
