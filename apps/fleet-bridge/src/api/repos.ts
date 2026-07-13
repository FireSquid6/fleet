/**
 * api/repos.ts — the bridge's repo registry: list, register, and remove the repos
 * the fleet can create workspaces from. One Elysia chain so route types stay
 * inferable for Eden.
 */

import { Elysia, t } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapError } from "./http";

export function reposPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-repos" })
    .get("/repos", async ({ set }) => {
      try {
        return await manager.listRepos();
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .post(
      "/repos",
      async ({ body, set }) => {
        try {
          set.status = 201;
          return await manager.addRepo(body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        body: t.Object({
          name: t.String(),
          url: t.String(),
          provider: t.Optional(t.String()),
        }),
      },
    )
    .delete("/repos/:name", async ({ params, set }) => {
      try {
        await manager.removeRepo(params.name);
        return { ok: true as const };
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    });
}
