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
import { Logestic } from "logestic";
import { MAX_CLIENT_FRAME_BYTES, type TerminalBridge } from "webterm";

export function createApp(
  manager: WorkspaceManager,
  _config: FleetShipConfig,
  createTerminal?: (options: ConstructorParameters<typeof TerminalBridge>[0]) => Pick<TerminalBridge, "handle" | "stop">,
  terminalInitTimeoutMs?: number,
) {
  return new Elysia({ websocket: { maxPayloadLength: MAX_CLIENT_FRAME_BYTES } })
    .use(Logestic.preset("commontz"))
    .use(workspacesPlugin(manager, createTerminal, terminalInitTimeoutMs))
    .use(eventsPlugin(manager))
    .use(systemResourcesPlugin())

}

export type App = ReturnType<typeof createApp>;
