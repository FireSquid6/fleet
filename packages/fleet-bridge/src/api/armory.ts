import { Elysia, t } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapErrorHook } from "./http";

export function armoryPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-armory" })
    .get("/armory/ships", () => manager.armoryShipStates())
    .onError(mapErrorHook)
    .get("/armory", () => manager.armoryManifest())
    .get("/armory/file", ({ query }) => manager.armoryFile(query.path), {
      query: t.Object({ path: t.String() }),
    });
}
