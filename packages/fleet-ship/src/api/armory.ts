/**
 * api/armory.ts — the ship's armory routes: the bridge pushes `/armory/sync` to
 * say "re-pull and re-install", and anyone can read back what this ship
 * currently has cached and applied.
 * One Elysia chain so route types stay inferable for Eden.
 */

import { Elysia, t } from "elysia";
import { ArmoryCache, ArmorySyncError } from "../armory/armory-cache";
import { syncAndInstall } from "../armory/armory-sync";
import { mapError } from "./http";

export function armoryPlugin(cache: ArmoryCache) {
  return new Elysia({ name: "ship-armory" })
    .post(
      "/armory/sync",
      async ({ body, set }) => {
        try {
          return await syncAndInstall(cache, body);
        } catch (err) {
          const mapped = mapArmoryError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { body: t.Object({ bridgeUrl: t.String(), revision: t.String() }) },
    )
    .get("/armory", async ({ set }) => {
      try {
        return await cache.state();
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
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
