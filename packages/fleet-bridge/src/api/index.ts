/**
 * api/index.ts — composes the bridge's Elysia app from its two plugins.
 *
 * Both plugins are single Elysia chains, so `.use()` merges their route types
 * into the parent and `App = ReturnType<typeof createApp>` carries the full
 * merged surface for a future Eden `treaty<App>` client.
 */

import { Elysia } from "elysia";
import { MAX_CLIENT_FRAME_BYTES } from "webterm/protocol";
import type { FleetManager } from "../fleet-manager";
import type { AuthService } from "../auth-service";
import { DEFAULT_SESSION_TTL_MS, type BridgeConfig } from "../config";
import { workspacesPlugin } from "./workspaces";
import { shipsPlugin } from "./ships";
import { systemResourcesPlugin } from "./system-resources";
import { reposPlugin } from "./repos";
import { authPlugin } from "./auth";
import { Logestic } from "logestic";

export function createApp(manager: FleetManager, config: BridgeConfig, auth: AuthService) {
  return new Elysia({ websocket: { maxPayloadLength: MAX_CLIENT_FRAME_BYTES } })
    .use(Logestic.preset("commontz"))
    .use(
      authPlugin(auth, {
        sessionTtlMs: config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
        secure: process.env.NODE_ENV === "production",
      }),
    )
    .use(workspacesPlugin(manager, config.serviceToken))
    .use(shipsPlugin(manager))
    .use(systemResourcesPlugin(manager))
    .use(reposPlugin(manager));
}

export type App = ReturnType<typeof createApp>;
