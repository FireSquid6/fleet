import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { issueBranchName } from "fleet-protocol";
import { EdenFleetBridge } from "../src/data/eden";
import { makeBridgeClient } from "../src/data/client";
import { MockFleetBridge } from "../src/data/mock";
import type { RepoBranch, RepoIssue, WorkspaceEvent } from "../src/data/types";

describe("EdenFleetBridge workspace mutations hit the right routes", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: { method: string; path: string; body: unknown }[];
  let bridge: EdenFleetBridge;

  beforeEach(() => {
    requests = [];
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        let body: unknown = null;
        if (request.method !== "GET" && request.method !== "DELETE") {
          try {
            body = await request.json();
          } catch {
            body = null;
          }
        }
        requests.push({ method: request.method, path: url.pathname, body });
        return Response.json({ ok: true });
      },
    });
    bridge = new EdenFleetBridge(makeBridgeClient(`http://localhost:${server.port}`));
  });

  afterEach(() => server.stop(true));

  test("switchBranch POSTs to the branch route with the new branch", async () => {
    await bridge.switchBranch("api-gateway", "ws-1", "feat/x");
    expect(requests).toEqual([
      { method: "POST", path: "/workspaces/api-gateway/ws-1/branch", body: { branch: "feat/x" } },
    ]);
  });

  test("deleteWorkspace DELETEs the workspace route", async () => {
    await bridge.deleteWorkspace("api-gateway", "ws-1");
    expect(requests).toEqual([{ method: "DELETE", path: "/workspaces/api-gateway/ws-1", body: null }]);
  });
});

describe("MockFleetBridge workspace mutations", () => {
  test("switchBranch updates the branch and emits branch_changed", async () => {
    const mock = new MockFleetBridge();
    const events: WorkspaceEvent[] = [];
    const unsubscribe = mock.subscribeWorkspaces((e) => events.push(e));

    const target = (await mock.listWorkspaces())[0]!;
    await mock.switchBranch(target.repoName, target.name, "feat/new");

    const after = (await mock.listWorkspaces()).find(
      (w) => w.repoName === target.repoName && w.name === target.name,
    );
    expect(after?.branch).toBe("feat/new");
    expect(events.at(-1)).toMatchObject({
      type: "workspace.branch_changed",
      workspace: { name: target.name, branch: "feat/new" },
    });
    unsubscribe();
  });

  test("deleteWorkspace removes the workspace and emits removed", async () => {
    const mock = new MockFleetBridge();
    const events: WorkspaceEvent[] = [];
    mock.subscribeWorkspaces((e) => events.push(e));

    const before = await mock.listWorkspaces();
    const target = before[0]!;
    await mock.deleteWorkspace(target.repoName, target.name);

    const after = await mock.listWorkspaces();
    expect(after).toHaveLength(before.length - 1);
    expect(after.some((w) => w.repoName === target.repoName && w.name === target.name)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "workspace.removed", workspace: { name: target.name } });
  });

  test("deleteWorkspace rejects for an unknown workspace", async () => {
    const mock = new MockFleetBridge();
    await expect(mock.deleteWorkspace("nope", "nope")).rejects.toThrow("workspace not found");
  });
});

/**
 * The create-workspace form's own surface: the two lists it fills its pickers
 * from, and the create itself. The bridge 400s a create that names both a branch
 * and an issue, so *which keys are present* in the body is a contract rather than
 * a detail — hence the exact-body assertions below.
 */

const BRANCHES: RepoBranch[] = [
  { name: "develop", sha: "a".repeat(40) },
  { name: "main", sha: "b".repeat(40) },
];

const ISSUES: RepoIssue[] = [
  { number: 12, title: "Better create workspace issue", author: "firesquid", url: "https://example.test/12" },
];

const CREATED = {
  repoName: "api-gateway",
  name: "ws-1",
  branch: "main",
  active: false,
  agent: null,
  ship: "forge-01",
};

describe("EdenFleetBridge create-workspace reads and writes", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: { method: string; path: string; query: Record<string, string>; body: unknown }[];
  let bridge: EdenFleetBridge;
  /** Overrides the canned body for a path, to drive the failure cases. */
  let override: Map<string, unknown>;

  beforeEach(() => {
    requests = [];
    override = new Map();
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body: request.method === "POST" ? await request.json() : undefined,
        });
        if (override.has(url.pathname)) return Response.json(override.get(url.pathname));
        if (url.pathname === "/repos/api-gateway/branches") return Response.json(BRANCHES);
        if (url.pathname === "/repos/api-gateway/issues") return Response.json(ISSUES);
        if (url.pathname === "/workspaces") return Response.json(CREATED, { status: 201 });
        return Response.json({ error: "unexpected route" }, { status: 404 });
      },
    });
    bridge = new EdenFleetBridge(makeBridgeClient(`http://localhost:${server.port}`));
  });

  afterEach(() => server.stop(true));

  test("listRepoBranches GETs /repos/:name/branches", async () => {
    expect(await bridge.listRepoBranches("api-gateway")).toEqual(BRANCHES);
    expect(requests).toEqual([
      { method: "GET", path: "/repos/api-gateway/branches", query: {}, body: undefined },
    ]);
  });

  test("listRepoIssues GETs /repos/:name/issues filtered to the open ones", async () => {
    expect(await bridge.listRepoIssues("api-gateway")).toEqual(ISSUES);
    expect(requests).toEqual([
      { method: "GET", path: "/repos/api-gateway/issues", query: { state: "open" }, body: undefined },
    ]);
  });

  test("a branch-mode create sends branch and no issueNumber", async () => {
    await bridge.createWorkspace({ ship: "forge-01", repoName: "api-gateway", name: "ws-1", branch: "main" });

    expect(requests[0]).toEqual({
      method: "POST",
      path: "/workspaces",
      query: {},
      body: { ship: "forge-01", repoName: "api-gateway", name: "ws-1", branch: "main" },
    });
  });

  test("an issue-mode create sends issueNumber and no branch key at all", async () => {
    await bridge.createWorkspace({ ship: "forge-01", repoName: "api-gateway", name: "ws-1", issueNumber: 12 });

    expect(requests[0]!.body).toEqual({
      ship: "forge-01",
      repoName: "api-gateway",
      name: "ws-1",
      issueNumber: 12,
    });
    expect(Object.keys(requests[0]!.body as object)).not.toContain("branch");
  });

  test("a branch left undefined never reaches the wire", async () => {
    await bridge.createWorkspace({
      ship: "forge-01",
      repoName: "api-gateway",
      name: "ws-1",
      branch: undefined,
      issueNumber: 12,
    });

    expect(Object.keys(requests[0]!.body as object)).not.toContain("branch");
  });

  test("an in-band { error } body on a 200 throws rather than returning it", async () => {
    override.set("/repos/api-gateway/branches", { error: "could not list branches for repo" });
    override.set("/repos/api-gateway/issues", { error: "provider is not supported yet" });

    await expect(bridge.listRepoBranches("api-gateway")).rejects.toThrow("fleet-bridge request failed");
    await expect(bridge.listRepoIssues("api-gateway")).rejects.toThrow("fleet-bridge request failed");
  });

  test("an error status is surfaced as a rejection", async () => {
    await expect(bridge.listRepoBranches("missing")).rejects.toThrow("fleet-bridge request failed");
  });
});

describe("MockFleetBridge create-workspace surface", () => {
  /** A seeded repo whose provider can answer issue queries. */
  const REPO = "api-gateway";

  test("listRepoBranches answers for a registered repo and rejects an unknown one", async () => {
    const mock = new MockFleetBridge();

    const names = (await mock.listRepoBranches(REPO)).map((b) => b.name);
    expect(names).toContain("main");
    // The bridge answers this route from `ls-remote` sorted by name, and the
    // picker's tie-breaking inherits that order; a fixture appended out of order
    // would quietly diverge from it.
    expect(names).toEqual([...names].sort());
    await expect(mock.listRepoBranches("nope")).rejects.toThrow("repo not found");
  });

  test("listRepoIssues answers for a provider-backed repo and refuses a custom one", async () => {
    const mock = new MockFleetBridge();

    expect((await mock.listRepoIssues(REPO)).length).toBeGreaterThan(0);
    await expect(mock.listRepoIssues("notifier")).rejects.toThrow("is not supported yet");
  });

  test("a create from an issue lands on the branch that issue derives", async () => {
    const mock = new MockFleetBridge();
    const issue = (await mock.listRepoIssues(REPO))[0]!;

    const workspace = await mock.createWorkspace({
      ship: "forge-01",
      repoName: REPO,
      name: "ws-from-issue",
      issueNumber: issue.number,
    });

    expect(workspace.branch).toBe(issueBranchName(issue));
    expect(await mock.listWorkspaces()).toContainEqual(workspace);
  });

  test("the issue fixture exercises punctuation and truncation", async () => {
    const issues = await new MockFleetBridge().listRepoIssues(REPO);
    const names = issues.map((issue) => issueBranchName(issue));

    expect(names.every((name) => /^[0-9a-z-]+$/.test(name))).toBe(true);
    expect(issues.some((issue) => /[^\w ]/.test(issue.title))).toBe(true);
    // One title outgrows its branch name, so the picker's preview shows a
    // truncated one. Asserted against the derived name rather than a length,
    // which would pin `fleet-protocol`'s cap from another package's test.
    expect(issues.some((issue, i) => issue.title.length > names[i]!.length)).toBe(true);
  });

  test("a create from an issue on a custom repo is refused, as on the bridge", async () => {
    await expect(
      new MockFleetBridge().createWorkspace({
        ship: "forge-01",
        repoName: "notifier",
        name: "ws-custom",
        issueNumber: 12,
      }),
    ).rejects.toThrow("is not supported yet");
  });

  test("a create naming both a branch and an issue is refused", async () => {
    await expect(
      new MockFleetBridge().createWorkspace({
        ship: "forge-01",
        repoName: REPO,
        name: "ws-both",
        branch: "main",
        issueNumber: 12,
      }),
    ).rejects.toThrow("not both");
  });

  test("a create naming neither is refused", async () => {
    await expect(
      new MockFleetBridge().createWorkspace({ ship: "forge-01", repoName: REPO, name: "ws-neither" }),
    ).rejects.toThrow("either a branch or an issue");
  });

  test("a blank branch is refused rather than recorded verbatim", async () => {
    const mock = new MockFleetBridge();

    await expect(
      mock.createWorkspace({ ship: "forge-01", repoName: REPO, name: "ws-blank", branch: "   " }),
    ).rejects.toThrow("branch must not be empty");
    expect((await mock.listWorkspaces()).some((w) => w.name === "ws-blank")).toBe(false);
  });

  test("an issue number that cannot identify an issue is refused before it is looked up", async () => {
    const mock = new MockFleetBridge();

    for (const issueNumber of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        mock.createWorkspace({ ship: "forge-01", repoName: REPO, name: "ws-bad", issueNumber }),
      ).rejects.toThrow("issueNumber must be a positive integer");
    }
  });

  test("a plain branch create still works and keeps the branch verbatim", async () => {
    const workspace = await new MockFleetBridge().createWorkspace({
      ship: "forge-01",
      repoName: REPO,
      name: "ws-plain",
      branch: "feature/x",
    });

    expect(workspace).toEqual({
      ship: "forge-01",
      repoName: REPO,
      name: "ws-plain",
      branch: "feature/x",
      active: false,
      agent: null,
      ephemeral: null,
    });
  });
});
