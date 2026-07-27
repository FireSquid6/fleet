/**
 * workspace-from-issue.test.ts — `POST /workspaces` driven in-process with both
 * a fake ship and a fake provider, covering the `issueNumber` branch source:
 * which provider calls it makes, what branch the ship ends up being handed, and
 * the validation and reservation behaviour around a provider failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "fleet-protocol";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { Store } from "../src/store/store";
import { ProviderError, type Issue, type RepoProvider } from "../src/providers";
import { FakeSocket, makeDeps, type FakeShip } from "./helpers";

/** Records what the fake provider was asked to do. */
interface Recorder {
  getIssueNumber?: number;
  linkBranch?: { issueNumber: number; branch: string };
}

const issue: Issue = {
  number: 12,
  title: "Better create workspace issue",
  state: "open",
  author: "octocat",
  url: "https://github.com/acme/repo1/issues/12",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  body: "details",
  comments: 1,
};

describe("POST /workspaces from an issue", () => {
  let dir: string;
  let manager: FleetManager;
  let app: ReturnType<typeof createApp>;
  let ships: Map<string, FakeShip>;
  let recorder: Recorder;
  /** When set, `linkBranchToIssue` throws this instead of succeeding. */
  let linkFailsWith: ProviderError | undefined;
  /** Name the provider claims to have created; defaults to the requested one. */
  let linkReturns: string | undefined;

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
      async getIssue(number: number) {
        recorder.getIssueNumber = number;
        return issue;
      },
      async linkBranchToIssue(issueNumber: number, branch: string) {
        recorder.linkBranch = { issueNumber, branch };
        if (linkFailsWith) throw linkFailsWith;
        return { name: linkReturns ?? branch, sha: "sha-of-linked-branch" };
      },
    } as RepoProvider;
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

  /** The branch the fake ship recorded for a workspace it was asked to create. */
  function branchTheShipReceived(name: string): string | undefined {
    return ships.get("http://ship-a")!.workspaces.find((w) => w.name === name)?.branch;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-issue-ws-"));
    FakeSocket.byBase.clear();
    recorder = {};
    linkFailsWith = undefined;
    linkReturns = undefined;
    ships = new Map<string, FakeShip>([["http://ship-a", { name: "ship-a", workspaces: [] }]]);
    const config = { dataDirectory: dir, port: 4902, name: "bridge" };
    const store = new Store(dir);
    await store.load();
    await store.createShip({ name: "ship-a", url: "http://ship-a" });
    manager = new FleetManager(config, makeDeps(ships), {
      syncTimeoutMs: 50,
      store,
      providerFor: makeProvider,
    });
    await manager.init();
    app = createApp(manager, config);
    expect(
      (await call("POST", "/repos", { name: "repo1", url: "https://github.com/acme/repo1", provider: "github" }))
        .status,
    ).toBe(201);
  });
  afterEach(async () => {
    manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  test("derives the branch name from the issue and links it before cloning", async () => {
    const res = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo1",
      name: "twelve",
      issueNumber: 12,
    });

    expect(res.status).toBe(201);
    expect(recorder.getIssueNumber).toBe(12);
    expect(recorder.linkBranch).toEqual({ issueNumber: 12, branch: "12-better-create-workspace-issue" });
    expect(branchTheShipReceived("twelve")).toBe("12-better-create-workspace-issue");
    expect(res.body).toMatchObject({
      repoName: "repo1",
      name: "twelve",
      branch: "12-better-create-workspace-issue",
      ship: "ship-a",
    });
  });

  test("hands the ship the name the provider returned, not the computed one", async () => {
    linkReturns = "12-better-create-workspace-issue-1";

    const res = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo1",
      name: "twelve",
      issueNumber: 12,
    });

    expect(res.status).toBe(201);
    expect(recorder.linkBranch!.branch).toBe("12-better-create-workspace-issue");
    expect(branchTheShipReceived("twelve")).toBe("12-better-create-workspace-issue-1");
    expect(res.body.branch).toBe("12-better-create-workspace-issue-1");
  });

  test("a plain branch create never touches the provider", async () => {
    const res = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo1",
      name: "plain",
      branch: "main",
    });

    expect(res.status).toBe(201);
    expect(res.body.branch).toBe("main");
    expect(recorder).toEqual({});
  });

  test.each([
    ["both a branch and an issue", { branch: "main", issueNumber: 12 }],
    ["neither", {}],
    ["a blank branch", { branch: "   " }],
    ["a non-integer issue number", { issueNumber: 1.5 }],
    ["a zero issue number", { issueNumber: 0 }],
  ])("rejects %s with 400", async (_label, extra) => {
    const res = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo1",
      name: "rejected",
      ...extra,
    });

    expect(res.status).toBe(400);
    expect(recorder).toEqual({});
    expect(ships.get("http://ship-a")!.createCalls).toBeUndefined();
  });

  test("a failed link surfaces its status and leaves no reservation behind", async () => {
    linkFailsWith = new ProviderError("authentication required", 401);
    const body = { ship: "ship-a", repoName: "repo1", name: "twelve", issueNumber: 12 };

    const first = await call("POST", "/workspaces", body);
    expect(first.status).toBe(401);
    expect(ships.get("http://ship-a")!.createCalls).toBeUndefined();

    // A retry must fail the same way, not 409 on a reservation the first attempt left.
    const second = await call("POST", "/workspaces", body);
    expect(second.status).toBe(401);
    expect(second.body.error).not.toContain("already in progress");
  });

  test("a ship failure after a successful link clears the reservation too", async () => {
    ships.get("http://ship-a")!.errorResponse = { status: 409, message: "clone destination exists" };
    const body = { ship: "ship-a", repoName: "repo1", name: "twelve", issueNumber: 12 };

    expect((await call("POST", "/workspaces", body)).status).toBe(409);

    ships.get("http://ship-a")!.errorResponse = undefined;
    const retry = await call("POST", "/workspaces", body);
    expect(retry.status).toBe(201);
    expect(retry.body.branch).toBe("12-better-create-workspace-issue");
  });
});
