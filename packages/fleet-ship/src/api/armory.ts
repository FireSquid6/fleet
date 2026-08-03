import { Elysia, t } from "elysia";
import { ArmoryCache, ArmorySyncError } from "../armory/armory-cache";
import { syncAndInstall } from "../armory/armory-sync";
import { errorHook, mapError } from "./http";

export function armoryPlugin(cache: ArmoryCache) {
  return new Elysia({ name: "ship-armory" })
    .get("/armory", async ({ set }) => {
      try {
        return await cache.state();
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .onError(errorHook(mapArmoryError))
    .post("/armory/sync", ({ body }) => syncAndInstall(cache, body), {
      body: t.Object({ bridgeUrl: t.String(), revision: t.String() }),
    });
}

/**
 * A failed pull is the bridge's fault (502), the push body's (400), or a push
 * from a bridge this ship is not pinned to (403) — never a plain 500.
 */
function mapArmoryError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof ArmorySyncError) return { status: err.status, body: { error: err.message } };
  return mapError(err);
}
