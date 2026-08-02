import { Elysia, t } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapError } from "./http";

export function armoryPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-armory" })
    .get("/armory", async ({ set }) => {
      try {
        return await manager.armoryManifest();
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .get(
      "/armory/file",
      async ({ query, set }) => {
        try {
          return await manager.armoryFile(query.path);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { query: t.Object({ path: t.String() }) },
    )
    .get("/armory/ships", () => manager.armoryShipStates());
}
