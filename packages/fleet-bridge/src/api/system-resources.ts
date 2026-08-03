import { Elysia } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapErrorHook } from "./http";

export function systemResourcesPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-system-resources" })
    .get("/system-resources", () => manager.listSystemResources())
    .onError(mapErrorHook)
    .get("/ships/:ship/system-resources", ({ params }) => manager.getShipSystemResources(params.ship));
}
