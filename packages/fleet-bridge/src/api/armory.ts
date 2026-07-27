/**
 * api/armory.ts — the read side of the Armory: the manifest of the bridge's
 * `armory/` directory, the contents of any file it lists, and what each ship has
 * applied. Ships poll the first two to decide whether to re-pull; the last is for
 * operators watching the fleet converge. One Elysia chain so route types stay
 * inferable for Eden.
 */

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
