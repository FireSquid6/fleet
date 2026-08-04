import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "fleet-protocol";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { Store } from "../src/store/store";
import {
  ProviderError,
  type CheckRun,
  type FailedJobLog,
  type Issue,
  type IssueComment,
  type IssueSummary,
  type ListOptions,
  type PullRequest,
  type PullRequestSummary,
  type RepoInfo,
  type RepoProvider,
  type Review,
  type ReviewEvent,
} from "../src/providers";
import { makeDeps } from "./helpers";

/** Records the args each provider method was called with, per repo. */
interface Recorder {
  repo?: Repo;
  listIssuesOptions?: ListOptions;
  getIssueNumber?: number;
  commentIssue?: { number: number; body: string };
  reviewPr?: { number: number; review: { event: ReviewEvent; body?: string } };
  checksRef?: string;
  failedLogsRef?: string;
}

const info: RepoInfo = {
  name: "repo1",
  fullName: "acme/repo1",
  description: "a repo",
  url: "https://github.com/acme/repo1",
  defaultBranch: "main",
  private: false,
  stars: 7,
  openIssues: 3,
};

const issueSummary: IssueSummary = {
  number: 12,
  title: "a bug",
  state: "open",
  author: "octocat",
  url: "https://github.com/acme/repo1/issues/12",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const issue: Issue = { ...issueSummary, body: "details", comments: 1 };

const comment: IssueComment = {
  id: 99,
  author: "octocat",
  body: "thanks",
  url: "https://github.com/acme/repo1/issues/12#issuecomment-99",
  createdAt: "2026-01-03T00:00:00.000Z",
};

const review: Review = {
  id: 5,
  state: "APPROVED",
  author: "octocat",
  body: "lgtm",
  url: "https://github.com/acme/repo1/pull/8#pullrequestreview-5",
};

const prSummary: PullRequestSummary = {
  ...issueSummary,
  number: 8,
  draft: false,
  baseBranch: "main",
  headBranch: "feature",
};

const pr: PullRequest = {
  ...prSummary,
  body: "the change",
  merged: false,
  mergeable: true,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  headSha: "sha-of-pr-8",
};

const checkRun: CheckRun = {
  name: "build",
  status: "completed",
  conclusion: "failure",
  detailsUrl: "https://github.com/acme/repo1/runs/1",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:05:00.000Z",
};

const failedLog: FailedJobLog = { workflow: "CI", job: "test", jobId: 901, log: "boom" };

describe("repo provider API", () => {
  let dir: string;
  let manager: FleetManager;
  let app: ReturnType<typeof createApp>;
  let recorder: Recorder;
  /** When set, the fake provider throws this on every call. */
  let failWith: ProviderError | undefined;

  function makeProvider(repo: Repo): RepoProvider {
    recorder.repo = repo;
    const guard = () => {
      if (failWith) throw failWith;
    };
    return {
      async getInfo() {
        guard();
        return info;
      },
      async listIssues(options?: ListOptions) {
        guard();
        recorder.listIssuesOptions = options;
        return [issueSummary];
      },
      async getIssue(number: number) {
        guard();
        recorder.getIssueNumber = number;
        return issue;
      },
      async listPullRequests(options?: ListOptions) {
        guard();
        recorder.listIssuesOptions = options;
        return [prSummary];
      },
      async pullRequestsForBranch() {
        guard();
        return [prSummary];
      },
      async getPullRequest(number: number) {
        guard();
        recorder.getIssueNumber = number;
        return pr;
      },
      async commentOnIssue(number: number, body: string) {
        guard();
        recorder.commentIssue = { number, body };
        return comment;
      },
      async commentOnPullRequest(number: number, body: string) {
        guard();
        recorder.commentIssue = { number, body };
        return comment;
      },
      async reviewPullRequest(number: number, r: { event: ReviewEvent; body?: string }) {
        guard();
        recorder.reviewPr = { number, review: r };
        return review;
      },
      async listChecks(ref: string) {
        guard();
        recorder.checksRef = ref;
        return [checkRun];
      },
      async getFailedLogs(ref: string) {
        guard();
        recorder.failedLogsRef = ref;
        return [failedLog];
      },
      // Unused by these routes, but the interface requires it.
      async linkBranchToIssue(_issueNumber: number, branch: string) {
        guard();
        return { name: branch, sha: "sha-of-linked-branch" };
      },
    };
  }

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.handle(
      new Request(`http://bridge${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-provider-"));
    recorder = {};
    failWith = undefined;
    const config = { dataDirectory: dir, port: 4900, name: "bridge" };
    const store = new Store(dir);
    await store.load();
    manager = new FleetManager(config, makeDeps(new Map()), {
      syncTimeoutMs: 50,
      store,
      providerFor: makeProvider,
    });
    await manager.init();
    app = createApp(manager);
    // Register the repo so the lookup in withProvider succeeds.
    expect((await call("POST", "/repos", { name: "repo1", url: "https://github.com/acme/repo1", provider: "github" })).status).toBe(201);
  });
  afterEach(async () => {
    manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  test("GET /repos/:name/info returns the canned info and calls the provider", async () => {
    const res = await call("GET", "/repos/repo1/info");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(info);
    expect(recorder.repo).toMatchObject({ name: "repo1", provider: "github" });
  });

  test("GET /repos/:name/issues forwards the state query", async () => {
    const res = await call("GET", "/repos/repo1/issues?state=closed");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([issueSummary]);
    expect(recorder.listIssuesOptions).toEqual({ state: "closed" });

    await call("GET", "/repos/repo1/issues");
    expect(recorder.listIssuesOptions).toEqual({ state: undefined });
  });

  test("GET /repos/:name/issues/:number returns the issue; non-numeric is 422", async () => {
    const res = await call("GET", "/repos/repo1/issues/12");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(issue);
    expect(recorder.getIssueNumber).toBe(12);

    expect((await call("GET", "/repos/repo1/issues/not-a-number")).status).toBe(422);
  });

  test("POST /repos/:name/issues/:number/comments returns 201 and forwards the body", async () => {
    const res = await call("POST", "/repos/repo1/issues/12/comments", { body: "thanks" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(comment);
    expect(recorder.commentIssue).toEqual({ number: 12, body: "thanks" });
  });

  test("POST /repos/:name/pulls/:number/reviews forwards {event, body}", async () => {
    const res = await call("POST", "/repos/repo1/pulls/8/reviews", { event: "APPROVE", body: "lgtm" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(review);
    expect(recorder.reviewPr).toEqual({ number: 8, review: { event: "APPROVE", body: "lgtm" } });
  });

  test("GET /repos/:name/checks?ref=main calls listChecks with that ref", async () => {
    const res = await call("GET", "/repos/repo1/checks?ref=main");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([checkRun]);
    expect(recorder.checksRef).toBe("main");
  });

  test("GET /repos/:name/checks?pr=8 resolves the PR head SHA then calls listChecks", async () => {
    const res = await call("GET", "/repos/repo1/checks?pr=8");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([checkRun]);
    expect(recorder.getIssueNumber).toBe(8);
    expect(recorder.checksRef).toBe(pr.headSha);
  });

  test("GET /repos/:name/checks with neither ref nor pr returns 400", async () => {
    const res = await call("GET", "/repos/repo1/checks");
    expect(res.status).toBe(400);
  });

  test("GET /repos/:name/checks/logs?ref=main returns the failed logs", async () => {
    const res = await call("GET", "/repos/repo1/checks/logs?ref=main");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([failedLog]);
    expect(recorder.failedLogsRef).toBe("main");
  });

  test("an unregistered repo returns 404", async () => {
    const res = await call("GET", "/repos/ghost/info");
    expect(res.status).toBe(404);
  });

  test("a ProviderError surfaces as its HTTP status", async () => {
    failWith = new ProviderError("nope", 501);
    const notImplemented = await call("GET", "/repos/repo1/info");
    expect(notImplemented.status).toBe(501);
    expect(notImplemented.body).toEqual({ error: "nope" });

    failWith = new ProviderError("gone", 404);
    expect((await call("GET", "/repos/repo1/issues/12")).status).toBe(404);
  });
});
