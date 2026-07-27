/**
 * api/index.ts — composes the bridge's Elysia app from its route plugins.
 *
 * Each plugin is a single Elysia chain, so `.use()` merges its route types
 * into the parent and `App = ReturnType<typeof createApp>` carries the full
 * merged surface for a future Eden `treaty<App>` client.
 */

import { Elysia } from "elysia";
import { MAX_CLIENT_FRAME_BYTES } from "webterm/protocol";
import type { FleetManager } from "../fleet-manager";
import type { BridgeConfig } from "../config";
import { workspacesPlugin } from "./workspaces";
import { shipsPlugin } from "./ships";
import { systemResourcesPlugin } from "./system-resources";
import { reposPlugin } from "./repos";
import { armoryPlugin } from "./armory";
import { eventsPlugin } from "./events";
import { Logestic } from "logestic";

export function createApp(manager: FleetManager, _config: BridgeConfig) {
  // Terminal frames are highly repetitive JSON; permessage-deflate is worth an
  // order of magnitude on them, and Bun's client WebSocket already offers the
  // extension, so accepting it here compresses the fleet-client→bridge hop.
  return new Elysia({ websocket: { maxPayloadLength: MAX_CLIENT_FRAME_BYTES, perMessageDeflate: true } })
    .use(Logestic.preset("commontz"))
    .use(workspacesPlugin(manager))
    .use(shipsPlugin(manager))
    .use(systemResourcesPlugin(manager))
    .use(reposPlugin(manager))
    .use(armoryPlugin(manager))
    .use(eventsPlugin(manager));
}

export type App = ReturnType<typeof createApp>;
