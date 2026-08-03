import { Elysia, t } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapErrorHook } from "./http";

export function shipsPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-ships" })
    .get("/ships", () => manager.listShips())
    .onError(mapErrorHook)
    .post(
      "/ships",
      async ({ body, set }) => {
        set.status = 201;
        return await manager.addShip(body.url);
      },
      { body: t.Object({ url: t.String() }) },
    )
    .delete("/ships/:name", async ({ params }) => {
      await manager.removeShip(params.name);
      return { ok: true as const };
    });
}
