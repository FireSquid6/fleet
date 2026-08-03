import { Elysia, t } from "elysia";
import type { FleetManager } from "../fleet-manager";
import { mapErrorHook } from "./http";

export function reposPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-repos" })
    .onError(mapErrorHook)
    .get("/repos", () => manager.listRepos())
    .post(
      "/repos",
      async ({ body, set }) => {
        set.status = 201;
        return await manager.addRepo(body);
      },
      {
        body: t.Object({
          name: t.String(),
          url: t.String(),
          provider: t.Optional(t.String()),
        }),
      },
    )
    .delete("/repos/:name", async ({ params }) => {
      await manager.removeRepo(params.name);
      return { ok: true as const };
    })
    .get("/repos/:name/info", ({ params }) => manager.repoInfo(params.name))
    .get("/repos/:name/branches", ({ params }) => manager.listRepoBranches(params.name))
    .get(
      "/repos/:name/issues",
      ({ params, query }) => manager.listRepoIssues(params.name, { state: query.state }),
      { query: stateQuery },
    )
    .get("/repos/:name/issues/:number", ({ params }) => manager.getRepoIssue(params.name, params.number), {
      params: numberParams,
    })
    .post(
      "/repos/:name/issues/:number/comments",
      async ({ params, body, set }) => {
        set.status = 201;
        return await manager.commentRepoIssue(params.name, params.number, body.body);
      },
      { params: numberParams, body: t.Object({ body: t.String() }) },
    )
    .get(
      "/repos/:name/pulls",
      ({ params, query }) => manager.listRepoPullRequests(params.name, { state: query.state }),
      { query: stateQuery },
    )
    .get(
      "/repos/:name/pulls/:number",
      ({ params }) => manager.getRepoPullRequest(params.name, params.number),
      { params: numberParams },
    )
    .post(
      "/repos/:name/pulls/:number/comments",
      async ({ params, body, set }) => {
        set.status = 201;
        return await manager.commentRepoPullRequest(params.name, params.number, body.body);
      },
      { params: numberParams, body: t.Object({ body: t.String() }) },
    )
    .post(
      "/repos/:name/pulls/:number/reviews",
      async ({ params, body, set }) => {
        set.status = 201;
        return await manager.reviewRepoPullRequest(params.name, params.number, body);
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
      ({ params, query }) => manager.listRepoChecks(params.name, { ref: query.ref, pr: query.pr }),
      { query: checkTargetQuery },
    )
    .get(
      "/repos/:name/checks/logs",
      ({ params, query }) => manager.getRepoFailedLogs(params.name, { ref: query.ref, pr: query.pr }),
      { query: checkTargetQuery },
    );
}

/** `:number` path param coerced to a number; non-numeric values are rejected (422). */
const numberParams = t.Object({ name: t.String(), number: t.Numeric() });

const stateQuery = t.Object({
  state: t.Optional(t.Union([t.Literal("open"), t.Literal("closed"), t.Literal("all")])),
});

const checkTargetQuery = t.Object({
  ref: t.Optional(t.String()),
  pr: t.Optional(t.Numeric()),
});
