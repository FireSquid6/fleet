/**
 * api/ships.ts — the bridge-only ship-management routes. One Elysia chain so
 * route types stay inferable for Eden.
 */

import { Elysia, t } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapError } from "./http";

export function shipsPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-ships" })
    .get("/ships", () => manager.listShips())
    .post(
      "/ships",
      async ({ body, set }) => {
        try {
          set.status = 201;
          return await manager.addShip(body.url);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { body: t.Object({ url: t.String() }) },
    )
    .delete("/ships/:name", async ({ params, set }) => {
      try {
        await manager.removeShip(params.name);
        return { ok: true as const };
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    });
}
