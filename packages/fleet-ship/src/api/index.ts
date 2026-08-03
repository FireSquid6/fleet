import { Elysia } from "elysia";
import type { WorkspaceManager } from "../workspace-manager";
import type { FleetShipConfig } from "fleet-protocol";
import { workspacesPlugin } from "./workspaces";
import { eventsPlugin } from "./events";
import { systemResourcesPlugin } from "./system-resources";
import { armoryPlugin } from "./armory";
import { ArmoryCache } from "../armory/armory-cache";
import { Logestic } from "logestic";
import { MAX_CLIENT_FRAME_BYTES, type TerminalBridge } from "webterm";

export function createApp(
  manager: WorkspaceManager,
  config: FleetShipConfig,
  createTerminal?: (options: ConstructorParameters<typeof TerminalBridge>[0]) => Pick<TerminalBridge, "handle" | "stop">,
  terminalInitTimeoutMs?: number,
  armory?: ArmoryCache,
) {
  // Every plugin must stay a single Elysia chain: `.use()` merges its route
  // types into `App`, which the CLI's Eden `treaty<App>` client depends on.
  //
  // Terminal frames are JSON whose keys and blank-cell `0`s repeat heavily, so
  // permessage-deflate is worth an order of magnitude on them. Bun's client
  // WebSocket offers the extension by default, so the bridge→ship hop starts
  // compressing purely from the server accepting it here.
  return new Elysia({ websocket: { maxPayloadLength: MAX_CLIENT_FRAME_BYTES, perMessageDeflate: true } })
    .use(Logestic.preset("commontz"))
    .use(workspacesPlugin(manager, createTerminal, terminalInitTimeoutMs))
    .use(eventsPlugin(manager))
    .use(systemResourcesPlugin())
    // The default cache carries the configured bridge pin; a caller passing its
    // own cache (tests) has already decided what that cache accepts.
    .use(armoryPlugin(armory ?? new ArmoryCache({ bridgeUrl: config.bridgeUrl })))

}

export type App = ReturnType<typeof createApp>;
