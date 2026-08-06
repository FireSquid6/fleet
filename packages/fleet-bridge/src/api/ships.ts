import { Elysia, t } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { requireAdmin } from "./auth";
import { mapErrorHook } from "./http";

export function shipsPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-ships" })
    .get("/ships", () => manager.listShips())
    .onError(mapErrorHook)
    .post(
      "/ships",
      async ({ request, body, set }) => {
        requireAdmin(request);
        set.status = 201;
        return await manager.addShip(body.url, { shipToken: body.shipToken, bridgeToken: body.bridgeToken });
      },
      {
        body: t.Object({
          url: t.String(),
          shipToken: t.Optional(t.String()),
          bridgeToken: t.Optional(t.String()),
        }),
      },
    )
    .delete("/ships/:name", async ({ request, params }) => {
      requireAdmin(request);
      await manager.removeShip(params.name);
      return { ok: true as const };
    });
}
