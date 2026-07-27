import { describe, expect, test } from "bun:test";
import type { Repo } from "fleet-protocol";
import { GitHubProvider, parseGitHubRepo } from "../src/providers/github";
import { ProviderError, providerFor } from "../src/providers";

/** Records the last fetch call so tests can assert on URL/method/headers/body. */
interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function fakeFetch(response: Response | (() => Response)): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

describe("parseGitHubRepo", () => {
  test("parses https URLs", () => {
    expect(parseGitHubRepo("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("parses https URLs with a .git suffix", () => {
    expect(parseGitHubRepo("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("parses https URLs with a trailing slash", () => {
    expect(parseGitHubRepo("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("parses ssh URLs", () => {
    expect(parseGitHubRepo("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("throws a ProviderError(400) on garbage", () => {
    try {
      parseGitHubRepo("not a url");
      throw new Error("expected parseGitHubRepo to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(400);
    }
  });
});

describe("GitHubProvider", () => {
  const repoPayload = {
    name: "repo",
    full_name: "owner/repo",
    description: "a repo",
    html_url: "https://github.com/owner/repo",
    default_branch: "main",
    private: false,
    stargazers_count: 42,
    open_issues_count: 3,
  };

  test("getInfo maps fields and calls the right URL with headers", async () => {
    const { fetch, calls } = fakeFetch(Response.json(repoPayload));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    const info = await provider.getInfo();

    expect(info).toEqual({
      name: "repo",
      fullName: "owner/repo",
      description: "a repo",
      url: "https://github.com/owner/repo",
      defaultBranch: "main",
      private: false,
      stars: 42,
      openIssues: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.get("Accept")).toBe("application/vnd.github+json");
    expect(calls[0]!.headers.get("User-Agent")).toBe("fleet-bridge");
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer t0ken");
  });

  test("respects a custom baseUrl", async () => {
    const { fetch, calls } = fakeFetch(Response.json(repoPayload));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch, baseUrl: "https://ghe.example.com/api/v3" });

    await provider.getInfo();

    expect(calls[0]!.url).toBe("https://ghe.example.com/api/v3/repos/owner/repo");
  });

  test("omits the Authorization header when no token is set", async () => {
    const { fetch, calls } = fakeFetch(Response.json(repoPayload));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    await provider.getInfo();

    expect(calls[0]!.headers.get("Authorization")).toBeNull();
  });

  test("getIssue maps the full issue shape", async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        number: 7,
        title: "a bug",
        state: "open",
        user: { login: "alice" },
        html_url: "https://github.com/owner/repo/issues/7",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        body: "details",
        comments: 2,
      }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    const issue = await provider.getIssue(7);

    expect(issue).toEqual({
      number: 7,
      title: "a bug",
      state: "open",
      author: "alice",
      url: "https://github.com/owner/repo/issues/7",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      body: "details",
      comments: 2,
    });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/issues/7");
  });

  test("getPullRequest maps the full PR shape", async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        number: 12,
        title: "a feature",
        state: "open",
        user: { login: "bob" },
        html_url: "https://github.com/owner/repo/pull/12",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        draft: true,
        base: { ref: "main" },
        head: { ref: "feature", sha: "deadbeef" },
        body: "does things",
        merged: false,
        mergeable: true,
        additions: 10,
        deletions: 4,
        changed_files: 2,
      }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    const pr = await provider.getPullRequest(12);

    expect(pr).toEqual({
      number: 12,
      title: "a feature",
      state: "open",
      author: "bob",
      url: "https://github.com/owner/repo/pull/12",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      draft: true,
      baseBranch: "main",
      headBranch: "feature",
      body: "does things",
      merged: false,
      mergeable: true,
      additions: 10,
      deletions: 4,
      changedFiles: 2,
      headSha: "deadbeef",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/pulls/12");
  });

  test("listIssues filters out elements carrying a pull_request key", async () => {
    const { fetch, calls } = fakeFetch(
      Response.json([
        {
          number: 1,
          title: "real issue",
          state: "open",
          user: { login: "alice" },
          html_url: "https://github.com/owner/repo/issues/1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          number: 2,
          title: "a PR masquerading as an issue",
          state: "open",
          user: null,
          html_url: "https://github.com/owner/repo/pull/2",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/2" },
        },
      ]),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    const issues = await provider.listIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]!.number).toBe(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/issues?state=open&per_page=100");
  });

  test("listIssues passes through an explicit state", async () => {
    const { fetch, calls } = fakeFetch(Response.json([]));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    await provider.listIssues({ state: "all" });

    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/issues?state=all&per_page=100");
  });

  test("listIssues asks for a full page, not GitHub's default 30", async () => {
    const { fetch, calls } = fakeFetch(Response.json([]));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    await provider.listIssues();

    expect(new URL(calls[0]!.url).searchParams.get("per_page")).toBe("100");
  });

  test("a 404 upstream response surfaces as a ProviderError with status 404", async () => {
    const { fetch } = fakeFetch(() => Response.json({ message: "Not Found" }, { status: 404 }));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    try {
      await provider.getInfo();
      throw new Error("expected getInfo to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(404);
      expect((error as ProviderError).message).toContain("Not Found");
    }
  });

  test("a 500 upstream response folds down to a ProviderError with status 502", async () => {
    const { fetch } = fakeFetch(() => new Response("boom", { status: 500 }));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    try {
      await provider.getInfo();
      throw new Error("expected getInfo to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(502);
    }
  });

  test("commentOnIssue throws ProviderError(401) without a token", async () => {
    const { fetch, calls } = fakeFetch(Response.json({}));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    try {
      await provider.commentOnIssue(1, "hi");
      throw new Error("expected commentOnIssue to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("commentOnIssue POSTs the right body when a token is present", async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        id: 99,
        user: { login: "alice" },
        body: "hi",
        html_url: "https://github.com/owner/repo/issues/1#issuecomment-99",
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    const comment = await provider.commentOnIssue(1, "hi");

    expect(comment).toEqual({
      id: 99,
      author: "alice",
      body: "hi",
      url: "https://github.com/owner/repo/issues/1#issuecomment-99",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/issues/1/comments");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: "hi" });
  });

  test("reviewPullRequest throws ProviderError(401) without a token", async () => {
    const { fetch, calls } = fakeFetch(Response.json({}));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    try {
      await provider.reviewPullRequest(1, { event: "APPROVE" });
      throw new Error("expected reviewPullRequest to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("reviewPullRequest POSTs event and body when a token is present", async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        id: 5,
        state: "APPROVED",
        user: { login: "bob" },
        body: "lgtm",
        html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-5",
      }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    const review = await provider.reviewPullRequest(1, { event: "APPROVE", body: "lgtm" });

    expect(review).toEqual({
      id: 5,
      state: "APPROVED",
      author: "bob",
      body: "lgtm",
      url: "https://github.com/owner/repo/pull/1#pullrequestreview-5",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/pulls/1/reviews");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ event: "APPROVE", body: "lgtm" });
  });

  test("listChecks maps check_runs fields and hits the check-runs endpoint", async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "failure",
            details_url: "https://github.com/owner/repo/runs/1",
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2026-01-01T00:05:00Z",
          },
        ],
      }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    const checks = await provider.listChecks("main");

    expect(checks).toEqual([
      {
        name: "build",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/owner/repo/runs/1",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:05:00Z",
      },
    ]);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/commits/main/check-runs");
  });

  test("getFailedLogs drives the full happy path and follows the log redirect without auth", async () => {
    const calls: FetchCall[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/commits/main")) return Response.json({ sha: "abc123" });
      if (url.includes("/actions/runs?head_sha=")) {
        return Response.json({ workflow_runs: [{ id: 55, name: "CI" }] });
      }
      if (url.endsWith("/actions/runs/55/jobs")) {
        return Response.json({
          jobs: [
            { id: 900, name: "lint", conclusion: "success" },
            { id: 901, name: "test", conclusion: "failure" },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/901/logs")) {
        return new Response(null, { status: 302, headers: { Location: "https://storage.example.com/log-901" } });
      }
      if (url === "https://storage.example.com/log-901") return new Response("boom: the test failed");
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    const logs = await provider.getFailedLogs("main");

    expect(logs).toEqual([{ workflow: "CI", job: "test", jobId: 901, log: "boom: the test failed" }]);

    const redirected = calls.find((c) => c.url === "https://storage.example.com/log-901");
    expect(redirected).toBeDefined();
    expect(redirected!.headers.get("Authorization")).toBeNull();
  });

  test("getFailedLogs throws ProviderError(401) without a token", async () => {
    const { fetch, calls } = fakeFetch(Response.json({}));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    try {
      await provider.getFailedLogs("main");
      throw new Error("expected getFailedLogs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("getFailedLogs throws 415 when a failed check has no Actions run behind it", async () => {
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/commits/main")) return Response.json({ sha: "abc123" });
      if (url.includes("/actions/runs?head_sha=")) return Response.json({ workflow_runs: [] });
      if (url.endsWith("/commits/main/check-runs")) {
        return Response.json({
          check_runs: [
            { name: "third-party", status: "completed", conclusion: "failure", details_url: null, started_at: null, completed_at: null },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    try {
      await provider.getFailedLogs("main");
      throw new Error("expected getFailedLogs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(415);
    }
  });

  /** The GraphQL operation a fake saw, so a test can answer per operation. */
  interface GraphQLCall {
    query: string;
    variables: Record<string, unknown>;
  }

  /**
   * Drive every REST read `linkBranchToIssue` makes, and route each GraphQL
   * operation to `graphql`. Refs other than `main` 404 unless `extraRefs` names
   * them — that is how the "branch exists but was never linked" path is set up.
   */
  function linkBranchFetch(
    graphql: (call: GraphQLCall) => Response,
    extraRefs: Record<string, string> = {},
  ): { fetch: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const refs: Record<string, string> = { main: "basesha", ...extraRefs };
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });

      const issue = /\/issues\/(\d+)$/.exec(url)?.[1];
      if (issue !== undefined) {
        return Response.json({
          number: Number(issue),
          node_id: `I_issue${issue}`,
          title: "a bug",
          state: "open",
          user: { login: "alice" },
          html_url: `https://github.com/owner/repo/issues/${issue}`,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          body: null,
          comments: 0,
        });
      }
      if (url.endsWith("/repos/owner/repo")) return Response.json(repoPayload);

      const ref = /\/git\/ref\/heads\/(.+)$/.exec(url)?.[1];
      if (ref !== undefined) {
        const sha = refs[ref];
        return sha === undefined
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json({ object: { sha } });
      }
      if (url.endsWith("/graphql")) return graphql(JSON.parse(body!) as GraphQLCall);
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    return { fetch: fn, calls };
  }

  const isMutation = (call: GraphQLCall) => call.query.includes("createLinkedBranch(");

  const createdRef = (name: string, oid: string) =>
    Response.json({ data: { createLinkedBranch: { linkedBranch: { ref: { name, target: { oid } } } } } });

  const linkedRefs = (...refs: { name: string; oid: string }[]) =>
    Response.json({
      data: {
        repository: {
          issue: {
            linkedBranches: {
              nodes: refs.map((ref) => ({ ref: { name: ref.name, target: { oid: ref.oid } } })),
            },
          },
        },
      },
    });

  /** The documented duplicate reply: HTTP 200, no `errors`, null `linkedBranch`. */
  const duplicateByNull = () =>
    Response.json({ data: { createLinkedBranch: { clientMutationId: null, issue: null, linkedBranch: null } } });

  /** The other duplicate reply: a refusal. The wording is not what makes it one. */
  const duplicateByError = () =>
    Response.json({ errors: [{ message: "A ref named 12-a-bug already exists in the repository" }] });

  test("linkBranchToIssue posts the mutation with the issue node id, base oid and name", async () => {
    const { fetch, calls } = linkBranchFetch(() => createdRef("12-a-bug", "newsha"));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    const linked = await provider.linkBranchToIssue(12, "12-a-bug");

    expect(linked).toEqual({ name: "12-a-bug", sha: "newsha" });

    const mutation = calls.find((c) => c.url.endsWith("/graphql"))!;
    expect(mutation.url).toBe("https://api.github.com/graphql");
    expect(mutation.method).toBe("POST");
    expect(mutation.headers.get("Authorization")).toBe("Bearer t0ken");
    const body = JSON.parse(mutation.body!) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("createLinkedBranch");
    expect(body.variables).toEqual({ issueId: "I_issue12", oid: "basesha", name: "12-a-bug" });
  });

  test("linkBranchToIssue returns the name GitHub actually created, not the requested one", async () => {
    const { fetch } = linkBranchFetch(() => createdRef("12-a-bug-1", "newsha"));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    expect(await provider.linkBranchToIssue(12, "12-a-bug")).toEqual({ name: "12-a-bug-1", sha: "newsha" });
  });

  test("linkBranchToIssue throws ProviderError(401) without a token", async () => {
    const { fetch, calls } = fakeFetch(Response.json({}));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("a GraphQL error on an HTTP 200 keeps its message when nothing can be resolved", async () => {
    const { fetch } = linkBranchFetch(() =>
      Response.json({ data: null, errors: [{ message: "Resource not accessible by integration" }] }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(502);
      expect((error as ProviderError).message).toContain("Resource not accessible by integration");
    }
  });

  // A refused create may only mean the branch is already there, and GitHub has
  // been seen reporting that both as a null `linkedBranch` on an HTTP 200 and as
  // an outright refusal — so both go looking before failing.
  test.each([
    ["a null linkedBranch with no errors", duplicateByNull],
    ["a refusal", duplicateByError],
  ])("%s resolves to the branch of the requested name linked to the issue", async (_label, duplicate) => {
    const { fetch, calls } = linkBranchFetch((call) =>
      isMutation(call) ? duplicate() : linkedRefs({ name: "12-a-bug", oid: "existingsha" }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    expect(await provider.linkBranchToIssue(12, "12-a-bug")).toEqual({ name: "12-a-bug", sha: "existingsha" });

    const query = calls.filter((c) => c.url.endsWith("/graphql")).at(-1)!;
    const body = JSON.parse(query.body!) as GraphQLCall;
    expect(body.query).toContain("linkedBranches");
    expect(body.variables).toEqual({ owner: "owner", repo: "repo", number: 12 });
  });

  test.each([
    ["a null linkedBranch with no errors", duplicateByNull],
    ["a refusal", duplicateByError],
  ])("%s ignores links under other names and takes the requested one", async (_label, duplicate) => {
    const { fetch } = linkBranchFetch((call) =>
      isMutation(call)
        ? duplicate()
        : linkedRefs({ name: "12-something-else", oid: "othersha" }, { name: "12-a-bug", oid: "existingsha" }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    expect(await provider.linkBranchToIssue(12, "12-a-bug")).toEqual({ name: "12-a-bug", sha: "existingsha" });
  });

  test("a branch of the requested name beats an unrelated branch linked to the issue", async () => {
    // Issue 42 was linked to "42-retries" by `gh issue develop`, and the name the
    // caller previewed exists too. Answering with "42-retries" would put the
    // workspace on a branch the user never saw.
    const { fetch } = linkBranchFetch(
      (call) => (isMutation(call) ? duplicateByNull() : linkedRefs({ name: "42-retries", oid: "OLDSHA" })),
      { "42-add-retries-to-the-sync-loop": "requestedsha" },
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    expect(await provider.linkBranchToIssue(42, "42-add-retries-to-the-sync-loop")).toEqual({
      name: "42-add-retries-to-the-sync-loop",
      sha: "requestedsha",
    });
  });

  test("a duplicate with no linked branch falls back to the branch of that name", async () => {
    const { fetch } = linkBranchFetch(
      (call) => (isMutation(call) ? duplicateByError() : linkedRefs()),
      { "12-a-bug": "unlinkedsha" },
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    expect(await provider.linkBranchToIssue(12, "12-a-bug")).toEqual({ name: "12-a-bug", sha: "unlinkedsha" });
  });

  test("a refusal whose wording nothing anticipated still resolves the existing branch", async () => {
    const { fetch } = linkBranchFetch(
      (call) =>
        isMutation(call)
          ? Response.json({ errors: [{ message: "Referenz existiert bereits" }] })
          : linkedRefs({ name: "12-a-bug", oid: "existingsha" }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    expect(await provider.linkBranchToIssue(12, "12-a-bug")).toEqual({ name: "12-a-bug", sha: "existingsha" });
  });

  test("a refused create with no branch of that name is a 409 carrying the reason", async () => {
    const { fetch } = linkBranchFetch((call) =>
      isMutation(call) ? duplicateByError() : linkedRefs({ name: "12-something-else", oid: "othersha" }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(409);
      expect((error as ProviderError).message).toContain("12-a-bug");
      // The branch linked under another name is reported, never returned.
      expect((error as ProviderError).message).toContain("already exists in the repository");
    }
  });

  test.each([
    ["a payload with no createLinkedBranch", { data: { createLinkedBranch: null } }],
    [
      "a created ref missing its target oid",
      { data: { createLinkedBranch: { linkedBranch: { ref: { name: "12-a-bug" } } } } },
    ],
  ])("%s is a ProviderError(502), not a duplicate", async (_label, payload) => {
    const { fetch, calls } = linkBranchFetch((call) =>
      isMutation(call) ? Response.json(payload) : linkedRefs({ name: "12-older-link", oid: "oldsha" }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(502);
    }
    // An unreadable reply must not be answered with some older branch: the
    // mutation may well have created the one that was asked for.
    expect(calls.filter((c) => c.url.endsWith("/graphql"))).toHaveLength(1);
  });

  test.each([401, 403, 404])(
    "an HTTP %i from the mutation is surfaced without looking for an existing branch",
    async (status) => {
      const { fetch, calls } = linkBranchFetch(() => Response.json({ message: "nope" }, { status }));
      const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

      try {
        await provider.linkBranchToIssue(12, "12-a-bug");
        throw new Error("expected linkBranchToIssue to throw");
      } catch (error) {
        expect((error as ProviderError).status).toBe(status);
      }
      expect(calls.filter((c) => c.url.endsWith("/graphql"))).toHaveLength(1);
    },
  );

  test("a non-404 from the branch lookup is surfaced instead of 'no such branch'", async () => {
    const { fetch } = linkBranchFetch((call) => {
      if (isMutation(call)) return duplicateByNull();
      return linkedRefs();
    });
    // Re-wrap so the ref lookup 403s rather than 404s.
    const forbidding = (async (input: string | URL | Request, init?: RequestInit) => {
      if (/\/git\/ref\/heads\/12-a-bug$/.test(String(input))) {
        return Response.json({ message: "Resource not accessible" }, { status: 403 });
      }
      return fetch(input as string, init);
    }) as unknown as typeof globalThis.fetch;
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch: forbidding });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect((error as ProviderError).status).toBe(403);
    }
  });

  test("linkBranchToIssue reports an issue with no node id as a 502", async () => {
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/issues/12")) return Response.json({ number: 12, title: "a bug" });
      throw new Error(`unexpected fetch: ${String(input)}`);
    }) as unknown as typeof globalThis.fetch;
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect((error as ProviderError).status).toBe(502);
    }
  });

  test("getFailedLogs returns [] when nothing failed and there are no Actions runs", async () => {
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/commits/main")) return Response.json({ sha: "abc123" });
      if (url.includes("/actions/runs?head_sha=")) return Response.json({ workflow_runs: [] });
      if (url.endsWith("/commits/main/check-runs")) {
        return Response.json({
          check_runs: [
            { name: "build", status: "completed", conclusion: "success", details_url: null, started_at: null, completed_at: null },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    expect(await provider.getFailedLogs("main")).toEqual([]);
  });
});

describe("providerFor", () => {
  test("returns a GitHubProvider for provider: github", () => {
    const repo: Repo = { name: "repo", url: "https://github.com/owner/repo", provider: "github" };
    const provider = providerFor(repo, { env: {} });
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  test("resolves the token from env (GITHUB_TOKEN then GH_TOKEN)", async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        name: "repo",
        full_name: "owner/repo",
        description: null,
        html_url: "https://github.com/owner/repo",
        default_branch: "main",
        private: false,
        stargazers_count: 0,
        open_issues_count: 0,
      }),
    );
    const repo: Repo = { name: "repo", url: "https://github.com/owner/repo", provider: "github" };
    const provider = providerFor(repo, { fetch, env: { GH_TOKEN: "envtoken" } });

    await provider.getInfo();

    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer envtoken");
  });

  test("throws ProviderError(501) for provider: gitlab", () => {
    const repo: Repo = { name: "repo", url: "https://gitlab.com/owner/repo", provider: "gitlab" };
    try {
      providerFor(repo, { env: {} });
      throw new Error("expected providerFor to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(501);
    }
  });
});
