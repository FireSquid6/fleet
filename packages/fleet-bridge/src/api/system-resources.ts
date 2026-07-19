/**
 * api/system-resources.ts — the bridge's system-resources routes: an aggregate
 * across all ships, plus a per-ship proxy. One Elysia chain so route types stay
 * inferable for Eden.
 */

import { Elysia } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapError } from "./http";

export function systemResourcesPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-system-resources" })
    .get("/system-resources", () => manager.listSystemResources())
    .get("/ships/:ship/system-resources", async ({ params, set }) => {
      try {
        return await manager.getShipSystemResources(params.ship);
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    });
}
