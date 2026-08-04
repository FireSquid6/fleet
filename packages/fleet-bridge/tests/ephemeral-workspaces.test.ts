import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "fleet-protocol";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { Store } from "../src/store/store";
import type { Issue, PullRequestSummary, RepoProvider } from "../src/providers";
import { FakeSocket, makeDeps, type FakeShip } from "./helpers";

const issue: Issue = {
  number: 37,
  title: "Add ephemeral workspaces",
  state: "open",
  author: "octocat",
  url: "https://github.com/acme/repo1/issues/37",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  body: "details",
  comments: 0,
};

const BRANCH = "37-add-ephemeral-workspaces";

describe("ephemeral workspaces", () => {
  let dir: string;
  let manager: FleetManager;
  let app: ReturnType<typeof createApp>;
  let ships: Map<string, FakeShip>;
  let store: Store;

  function makeProvider(_repo: Repo): RepoProvider {
    const unused = () => {
      throw new Error("not used by these tests");
    };
    return {
      getInfo: unused,
      listIssues: unused,
      listPullRequests: unused,
      getPullRequest: unused,
      commentOnIssue: unused,
      commentOnPullRequest: unused,
      reviewPullRequest: unused,
      listChecks: unused,
      getFailedLogs: unused,
      async pullRequestsForBranch(): Promise<PullRequestSummary[]> {
        return [];
      },
      async getIssue() {
        return issue;
      },
      async linkBranchToIssue(_issueNumber: number, branch: string) {
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

  async function createEphemeral(name: string, repoName = "repo1") {
    return call("POST", "/workspaces", { ship: "ship-a", repoName, name, issueNumber: 37, ephemeral: true });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-ephemeral-"));
    FakeSocket.byBase.clear();
    ships = new Map<string, FakeShip>([["http://ship-a", { name: "ship-a", workspaces: [] }]]);
    store = new Store(dir);
    await store.load();
    await store.createShip({ name: "ship-a", url: "http://ship-a" });
    manager = new FleetManager({ dataDirectory: dir, port: 4903, name: "bridge" }, makeDeps(ships), {
      syncTimeoutMs: 50,
      store,
      providerFor: makeProvider,
    });
    await manager.init();
    app = createApp(manager);
    expect(
      (await call("POST", "/repos", { name: "repo1", url: "https://github.com/acme/repo1", provider: "github" }))
        .status,
    ).toBe(201);
  });

  afterEach(async () => {
    manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  test("records an ephemeral workspace and reports it everywhere the workspace appears", async () => {
    const created = await createEphemeral("thirty-seven");

    expect(created.status).toBe(201);
    expect(created.body.ephemeral).toEqual({
      issueNumber: 37,
      branch: BRANCH,
      cleanup: "watching",
      blockedReason: null,
      blockedAt: null,
      pullRequest: null,
    });
    expect(await store.getEphemeral("repo1", "thirty-seven")).toMatchObject({ ship: "ship-a", branch: BRANCH });

    const listed = (await call("GET", "/workspaces")).body;
    expect(listed[0].ephemeral).toMatchObject({ issueNumber: 37, cleanup: "watching" });
    expect((await call("GET", "/workspaces/repo1/thirty-seven")).body.ephemeral).toMatchObject({ issueNumber: 37 });
    expect(manager.workspaceSnapshot()[0]?.ephemeral).toMatchObject({ issueNumber: 37 });
  });

  test("leaves an ordinary workspace unannotated", async () => {
    const created = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo1",
      name: "plain",
      branch: "dev",
    });

    expect(created.status).toBe(201);
    expect(created.body.ephemeral).toBeNull();
    expect(await store.getEphemeral("repo1", "plain")).toBeUndefined();
  });

  test("refuses to make a workspace ephemeral without an issue", async () => {
    const branchOnly = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo1",
      name: "nope",
      branch: "dev",
      ephemeral: true,
    });
    expect(branchOnly.status).toBe(400);
    expect(branchOnly.body.error).toContain("created from an issue");

    const neither = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo1",
      name: "nope",
      ephemeral: true,
    });
    expect(neither.status).toBe(400);
    expect(await manager.listWorkspaces()).toHaveLength(0);
  });

  test("keeps records across a bridge restart", async () => {
    await createEphemeral("thirty-seven");

    manager.shutdown();
    const reloadedStore = new Store(dir);
    await reloadedStore.load();
    const reloaded = new FleetManager({ dataDirectory: dir, port: 4903, name: "bridge" }, makeDeps(ships), {
      syncTimeoutMs: 50,
      store: reloadedStore,
      providerFor: makeProvider,
    });
    await reloaded.init();

    expect((await reloaded.listWorkspaces())[0]?.ephemeral).toMatchObject({ issueNumber: 37, branch: BRANCH });
    reloaded.shutdown();
  });

  test("forgets the record when the workspace, its ship, or its repo goes away", async () => {
    await createEphemeral("deleted");
    expect((await call("DELETE", "/workspaces/repo1/deleted")).status).toBe(200);
    expect(await store.getEphemeral("repo1", "deleted")).toBeUndefined();

    await createEphemeral("by-repo");
    expect((await call("DELETE", "/repos/repo1")).status).toBe(200);
    expect(await store.getEphemeral("repo1", "by-repo")).toBeUndefined();
    expect((await manager.listWorkspaces()).find((w) => w.name === "by-repo")?.ephemeral).toBeNull();

    expect(
      (await call("POST", "/repos", { name: "repo1", url: "https://github.com/acme/repo1", provider: "github" }))
        .status,
    ).toBe(201);
    await createEphemeral("by-ship");
    expect((await call("DELETE", "/ships/ship-a")).status).toBe(200);
    expect(await store.getEphemeral("repo1", "by-ship")).toBeUndefined();
  });
});
