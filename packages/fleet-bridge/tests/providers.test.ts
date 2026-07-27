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
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/issues?state=open");
  });

  test("listIssues passes through an explicit state", async () => {
    const { fetch, calls } = fakeFetch(Response.json([]));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", fetch });

    await provider.listIssues({ state: "all" });

    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/issues?state=all");
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

  /**
   * Drive the three REST reads `linkBranchToIssue` makes, then hand the GraphQL
   * mutation whatever `graphqlResponse` returns.
   */
  function linkBranchFetch(graphqlResponse: () => Response): { fetch: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/issues/12")) {
        return Response.json({
          number: 12,
          node_id: "I_issue12",
          title: "a bug",
          state: "open",
          user: { login: "alice" },
          html_url: "https://github.com/owner/repo/issues/12",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          body: null,
          comments: 0,
        });
      }
      if (url.endsWith("/repos/owner/repo")) return Response.json(repoPayload);
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "basesha" } });
      if (url.endsWith("/graphql")) return graphqlResponse();
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    return { fetch: fn, calls };
  }

  const linkedBranchPayload = () =>
    Response.json({
      data: {
        createLinkedBranch: {
          linkedBranch: { ref: { name: "12-a-bug", target: { oid: "newsha" } } },
        },
      },
    });

  test("linkBranchToIssue posts the mutation with the issue node id, base oid and name", async () => {
    const { fetch, calls } = linkBranchFetch(linkedBranchPayload);
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
    const { fetch } = linkBranchFetch(() =>
      Response.json({
        data: {
          createLinkedBranch: {
            linkedBranch: { ref: { name: "12-a-bug-1", target: { oid: "newsha" } } },
          },
        },
      }),
    );
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

  test("a GraphQL error carried on an HTTP 200 becomes a ProviderError(502)", async () => {
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

  test("a GraphQL 'already exists' error becomes a ProviderError(422)", async () => {
    const { fetch } = linkBranchFetch(() =>
      Response.json({ errors: [{ message: "A branch with that name already exists" }] }),
    );
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect((error as ProviderError).status).toBe(422);
    }
  });

  test("a GraphQL payload missing the created ref becomes a ProviderError(502)", async () => {
    const { fetch } = linkBranchFetch(() => Response.json({ data: { createLinkedBranch: null } }));
    const provider = new GitHubProvider({ owner: "owner", repo: "repo", token: "t0ken", fetch });

    try {
      await provider.linkBranchToIssue(12, "12-a-bug");
      throw new Error("expected linkBranchToIssue to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(502);
      expect((error as ProviderError).message).toContain("no branch");
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
