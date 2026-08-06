import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "fleet-protocol";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { Store } from "../src/store/store";
import type { Issue, PullRequestSummary, RepoProvider } from "../src/providers";
import { FakeSocket, makeAuthedApp, makeDeps, type FakeShip } from "./helpers";

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

function pull(number: number, state: string): PullRequestSummary {
  return {
    number,
    title: "a pull request",
    state,
    author: "octocat",
    url: `https://github.com/acme/repo1/pull/${number}`,
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-04T00:00:00.000Z",
    draft: false,
    baseBranch: "main",
    headBranch: BRANCH,
  };
}

describe("ephemeral workspaces", () => {
  let dir: string;
  let manager: FleetManager;
  let app: ReturnType<typeof createApp>;
  let authorization: string;
  let ships: Map<string, FakeShip>;
  let store: Store;
  let pulls: PullRequestSummary[];
  let issueState: string;
  let providerFailsWith: Error | undefined;
  let branchReads: number;

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
        branchReads += 1;
        if (providerFailsWith) throw providerFailsWith;
        return pulls;
      },
      async getIssue() {
        if (providerFailsWith) throw providerFailsWith;
        return { ...issue, state: issueState };
      },
      async linkBranchToIssue(_issueNumber: number, branch: string) {
        return { name: branch, sha: "sha-of-linked-branch" };
      },
    };
  }

  async function call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { authorization };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.handle(
      new Request(`http://bridge${path}`, {
        method,
        headers,
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
    pulls = [];
    issueState = "open";
    providerFailsWith = undefined;
    branchReads = 0;
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
    ({ app, authorization } = await makeAuthedApp(manager));
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

  describe("sweeping", () => {
    const shipA = () => ships.get("http://ship-a")!;

    test("destroys the workspace once every pull request on the branch is closed", async () => {
      await createEphemeral("done");
      pulls = [pull(41, "closed")];

      expect(await manager.sweepEphemeral()).toEqual({
        checked: 1,
        destroyed: 1,
        blocked: 0,
        skipped: 0,
        forgotten: 0,
      });
      expect(shipA().deletes).toEqual([{ repo: "repo1", name: "done", force: false }]);
      expect(shipA().workspaces).toHaveLength(0);
      expect(await store.getEphemeral("repo1", "done")).toBeUndefined();
      expect(await manager.listWorkspaces()).toHaveLength(0);
    });

    test("keeps watching while a pull request is open, and remembers which one", async () => {
      await createEphemeral("open-pr");
      pulls = [pull(41, "closed"), pull(42, "open")];

      expect(await manager.sweepEphemeral()).toMatchObject({ checked: 1, destroyed: 0 });
      expect(shipA().deletes).toBeUndefined();
      expect((await manager.listWorkspaces())[0]?.ephemeral).toMatchObject({
        cleanup: "watching",
        pullRequest: { number: 42, state: "open" },
      });
    });

    test("waits on an open issue that has no pull request, and cleans up once it closes", async () => {
      await createEphemeral("no-pr");

      expect(await manager.sweepEphemeral()).toMatchObject({ checked: 1, destroyed: 0 });
      expect((await manager.listWorkspaces())[0]?.ephemeral).toMatchObject({ pullRequest: null });

      issueState = "closed";
      expect(await manager.sweepEphemeral()).toMatchObject({ destroyed: 1 });
      expect(await store.getEphemeral("repo1", "no-pr")).toBeUndefined();
    });

    test("blocks, explains itself, and retries on the next pass", async () => {
      await createEphemeral("held");
      pulls = [pull(41, "closed")];
      shipA().heldWork = "workspace repo1/held holds work that is not on a remote: 2 commits not on any remote";

      expect(await manager.sweepEphemeral()).toMatchObject({ checked: 1, blocked: 1, destroyed: 0 });
      const blocked = (await manager.listWorkspaces())[0]?.ephemeral;
      expect(blocked).toMatchObject({
        cleanup: "blocked",
        blockedReason: shipA().heldWork,
        pullRequest: { number: 41, state: "closed" },
      });
      expect(blocked?.blockedAt).toBeString();
      expect(shipA().workspaces).toHaveLength(1);

      expect(await manager.sweepEphemeral()).toMatchObject({ blocked: 1 });

      shipA().heldWork = undefined;
      expect(await manager.sweepEphemeral()).toMatchObject({ destroyed: 1 });
      expect(await store.getEphemeral("repo1", "held")).toBeUndefined();
    });

    test("clears a block when the pull request reopens", async () => {
      await createEphemeral("reopened");
      pulls = [pull(41, "closed")];
      shipA().heldWork = "workspace repo1/reopened holds work that is not on a remote: a stash";
      await manager.sweepEphemeral();

      pulls = [pull(41, "open")];
      expect(await manager.sweepEphemeral()).toMatchObject({ blocked: 0, destroyed: 0 });
      expect((await manager.listWorkspaces())[0]?.ephemeral).toMatchObject({
        cleanup: "watching",
        blockedReason: null,
        blockedAt: null,
      });
    });

    test("truncates an over-long refusal", async () => {
      await createEphemeral("verbose");
      pulls = [pull(41, "closed")];
      shipA().heldWork = "x".repeat(500);

      await manager.sweepEphemeral();

      expect((await manager.listWorkspaces())[0]?.ephemeral?.blockedReason).toHaveLength(200);
    });

    test("skips an offline ship without blocking it", async () => {
      await createEphemeral("offline");
      pulls = [pull(41, "closed")];
      shipA().throws = true;
      await manager.listWorkspaces();

      expect(await manager.sweepEphemeral()).toEqual({
        checked: 0,
        destroyed: 0,
        blocked: 0,
        skipped: 1,
        forgotten: 0,
      });
      expect(await store.getEphemeral("repo1", "offline")).toMatchObject({ cleanup: "watching" });
    });

    test("forgets a record whose workspace an online ship no longer has", async () => {
      await createEphemeral("vanished");
      shipA().workspaces = [];
      await manager.listWorkspaces();

      expect(await manager.sweepEphemeral()).toMatchObject({ forgotten: 1, checked: 0 });
      expect(await store.getEphemeral("repo1", "vanished")).toBeUndefined();
    });

    test("leaves a repo alone when its provider cannot answer", async () => {
      await createEphemeral("unreadable");
      pulls = [pull(41, "closed")];
      providerFailsWith = new Error("rate limited");

      expect(await manager.sweepEphemeral()).toMatchObject({ destroyed: 0, blocked: 0, skipped: 1 });
      expect(shipA().deletes).toBeUndefined();
      expect(await store.getEphemeral("repo1", "unreadable")).toMatchObject({ cleanup: "watching" });
    });

    test("never touches an ordinary workspace", async () => {
      await call("POST", "/workspaces", { ship: "ship-a", repoName: "repo1", name: "plain", branch: "dev" });
      pulls = [pull(41, "closed")];

      expect(await manager.sweepEphemeral()).toEqual({
        checked: 0,
        destroyed: 0,
        blocked: 0,
        skipped: 0,
        forgotten: 0,
      });
      expect(shipA().workspaces).toHaveLength(1);
    });

    test("runs one pass at a time and reports it over HTTP", async () => {
      await createEphemeral("concurrent");

      const [first, second] = await Promise.all([manager.sweepEphemeral(), manager.sweepEphemeral()]);
      expect(branchReads).toBe(1);
      expect(first).toEqual(second);

      const res = await call("POST", "/workspaces/sweep");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ checked: 1, destroyed: 0, blocked: 0, skipped: 0, forgotten: 0 });
    });

    test("the timer sweeps on its own", async () => {
      await createEphemeral("timed");
      pulls = [pull(41, "closed")];

      manager.startSweeping(10);
      for (let attempt = 0; attempt < 100 && shipA().workspaces.length > 0; attempt++) {
        await Bun.sleep(10);
      }

      expect(shipA().workspaces).toHaveLength(0);
      expect(await store.getEphemeral("repo1", "timed")).toBeUndefined();
    });
  });
});
