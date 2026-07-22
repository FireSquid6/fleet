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
  config: FleetShipConfig,
  createTerminal?: (options: ConstructorParameters<typeof TerminalBridge>[0]) => Pick<TerminalBridge, "handle" | "stop">,
  terminalInitTimeoutMs?: number,
) {
  // A ship is only ever reached by the bridge or the CLI (never a browser), both of
  // which present the shared service token as a Bearer header on every request —
  // WebSocket upgrades included (they're HTTP GETs, so `onRequest` covers them).
  // When no token is configured the ship runs open, for staged rollout.
  const serviceToken = config.serviceToken ?? process.env.FLEET_SERVICE_TOKEN;
  const expected = serviceToken ? `Bearer ${serviceToken}` : undefined;

  return new Elysia({ websocket: { maxPayloadLength: MAX_CLIENT_FRAME_BYTES } })
    .onRequest(({ request, set }) => {
      if (!expected) return;
      if (request.headers.get("authorization") !== expected) {
        set.status = 401;
        return { error: "unauthorized" };
      }
    })
    .use(Logestic.preset("commontz"))
    .use(workspacesPlugin(manager, createTerminal, terminalInitTimeoutMs))
    .use(eventsPlugin(manager))
    .use(systemResourcesPlugin());
}

export type App = ReturnType<typeof createApp>;
