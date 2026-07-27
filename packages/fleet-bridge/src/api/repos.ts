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
    })
    .get("/repos/:name/info", async ({ params, set }) => {
      try {
        return await manager.repoInfo(params.name);
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .get("/repos/:name/branches", async ({ params, set }) => {
      try {
        return await manager.listRepoBranches(params.name);
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .get(
      "/repos/:name/issues",
      async ({ params, query, set }) => {
        try {
          return await manager.listRepoIssues(params.name, { state: query.state });
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { query: stateQuery },
    )
    .get(
      "/repos/:name/issues/:number",
      async ({ params, set }) => {
        try {
          return await manager.getRepoIssue(params.name, params.number);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { params: numberParams },
    )
    .post(
      "/repos/:name/issues/:number/comments",
      async ({ params, body, set }) => {
        try {
          set.status = 201;
          return await manager.commentRepoIssue(params.name, params.number, body.body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { params: numberParams, body: t.Object({ body: t.String() }) },
    )
    .get(
      "/repos/:name/pulls",
      async ({ params, query, set }) => {
        try {
          return await manager.listRepoPullRequests(params.name, { state: query.state });
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { query: stateQuery },
    )
    .get(
      "/repos/:name/pulls/:number",
      async ({ params, set }) => {
        try {
          return await manager.getRepoPullRequest(params.name, params.number);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { params: numberParams },
    )
    .post(
      "/repos/:name/pulls/:number/comments",
      async ({ params, body, set }) => {
        try {
          set.status = 201;
          return await manager.commentRepoPullRequest(params.name, params.number, body.body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { params: numberParams, body: t.Object({ body: t.String() }) },
    )
    .post(
      "/repos/:name/pulls/:number/reviews",
      async ({ params, body, set }) => {
        try {
          set.status = 201;
          return await manager.reviewRepoPullRequest(params.name, params.number, body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        params: numberParams,
        body: t.Object({
          event: t.Union([t.Literal("APPROVE"), t.Literal("REQUEST_CHANGES"), t.Literal("COMMENT")]),
          body: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/repos/:name/checks",
      async ({ params, query, set }) => {
        try {
          return await manager.listRepoChecks(params.name, { ref: query.ref, pr: query.pr });
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { query: checkTargetQuery },
    )
    .get(
      "/repos/:name/checks/logs",
      async ({ params, query, set }) => {
        try {
          return await manager.getRepoFailedLogs(params.name, { ref: query.ref, pr: query.pr });
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { query: checkTargetQuery },
    );
}

/** `:number` path param coerced to a number; non-numeric values are rejected (422). */
const numberParams = t.Object({ name: t.String(), number: t.Numeric() });

/** Optional `?state=open|closed|all` filter shared by the list endpoints. */
const stateQuery = t.Object({
  state: t.Optional(t.Union([t.Literal("open"), t.Literal("closed"), t.Literal("all")])),
});

/** `?ref=<commit-ish>` or `?pr=<number>` — the target a checks/logs query resolves. */
const checkTargetQuery = t.Object({
  ref: t.Optional(t.String()),
  pr: t.Optional(t.Numeric()),
});
