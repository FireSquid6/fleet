import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "git-bun";
import type { FleetEvent } from "fleet-protocol";
import { WorkspaceError, WorkspaceManager } from "../src/workspace-manager";

const config = { fleetDirectory: "/tmp/fleet-ship-test-fleet", port: 4700, name: "test-ship" };

// Pure helpers — no tmux/git shelling out, so these always run.
describe("WorkspaceManager pure helpers", () => {
  const manager = new WorkspaceManager(config);

  test("sessionName sanitizes dots and colons and joins repo/name", () => {
    expect(manager.sessionName("hello-world", "feature")).toBe("hello-world__feature");
    expect(manager.sessionName("my.repo", "a:b")).toBe("my-repo__a-b");
  });

  test("workspaceDir lays out <fleetDirectory>/<repo>/<name>", () => {
    expect(manager.workspaceDir("hello-world", "feature")).toBe(
      join(config.fleetDirectory, "hello-world", "feature"),
    );
  });
});

// End-to-end tests need both tmux and git on PATH; skip gracefully otherwise.
const tmuxAvailable = await (async () => {
  try {
    return (await Bun.$`tmux -V`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
})();
const gitAvailable = await (async () => {
  try {
    return (await Bun.$`git --version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
})();

const suite = tmuxAvailable && gitAvailable ? describe : describe.skip;
if (!tmuxAvailable || !gitAvailable) {
  console.warn("tmux and/or git not found on PATH — skipping workspace-manager end-to-end tests");
}

suite("WorkspaceManager end-to-end", () => {
  let fleetDirectory: string;
  let manager: WorkspaceManager;
  let sourceRepo: string;

  beforeAll(async () => {
    fleetDirectory = await mkdtemp(join(tmpdir(), "fleet-ship-fleet-"));
    manager = new WorkspaceManager({ fleetDirectory, port: 4700, name: "test-ship" });

    // A tiny local repo to clone from instead of hitting the network.
    sourceRepo = await mkdtemp(join(tmpdir(), "fleet-ship-source-"));
    const git = await Git.init(sourceRepo, { initialBranch: "main" });
    await Bun.write(join(sourceRepo, "README.md"), "hello\n");
    await git.add();
    await git.setConfig("user.email", "test@example.com");
    await git.setConfig("user.name", "Test");
    await git.commit("initial commit");
  });

  afterAll(async () => {
    // Clean up any tmux sessions this suite may have started.
    const active = await manager.list("active");
    for (const w of active) {
      await manager.deactivate(w.repoName, w.name).catch(() => {});
    }
    await rm(fleetDirectory, { recursive: true, force: true });
    await rm(sourceRepo, { recursive: true, force: true });
  });

  test("create clones a repo and leaves the workspace inactive", async () => {
    const summary = await manager.create({ url: sourceRepo, repoName: "repo", name: "ws1", branch: "main" });
    expect(summary.repoName).toBe("repo");
    expect(summary.name).toBe("ws1");
    expect(summary.branch).toBe("main");
    expect(summary.active).toBe(false);

    const status = await manager.get(summary.repoName, "ws1");
    expect(status.state).toBe("inactive");
  });

  test("create rejects a duplicate (repoName, name)", async () => {
    await manager.create({ url: sourceRepo, repoName: "repo", name: "ws-dup", branch: "main" });
    await expect(
      manager.create({ url: sourceRepo, repoName: "repo", name: "ws-dup", branch: "main" }),
    ).rejects.toThrow(WorkspaceError);
  });

  test("activate/deactivate toggle tmux session state", async () => {
    const summary = await manager.create({ url: sourceRepo, repoName: "repo", name: "ws2", branch: "main" });

    await manager.activate(summary.repoName, "ws2");
    const activeStatus = await manager.get(summary.repoName, "ws2");
    expect(activeStatus.state).toBe("active");
    if (activeStatus.state === "active") {
      expect(activeStatus.ship).toBe("test-ship");
      expect(activeStatus.diff).toEqual({ added: 0, removed: 0, commits: 0 });
    }

    await expect(manager.activate(summary.repoName, "ws2")).rejects.toThrow(WorkspaceError);

    await manager.deactivate(summary.repoName, "ws2");
    const inactiveStatus = await manager.get(summary.repoName, "ws2");
    expect(inactiveStatus.state).toBe("inactive");

    await expect(manager.deactivate(summary.repoName, "ws2")).rejects.toThrow(WorkspaceError);
  });

  test("remove deactivates and deletes the workspace directory", async () => {
    const summary = await manager.create({ url: sourceRepo, repoName: "repo", name: "ws3", branch: "main" });
    await manager.activate(summary.repoName, "ws3");
    await manager.remove(summary.repoName, "ws3");

    expect(await manager.has(summary.repoName, "ws3")).toBe(false);
    await expect(manager.get(summary.repoName, "ws3")).rejects.toThrow(WorkspaceError);
  });

  test("list filters by active state", async () => {
    const all = await manager.list();
    const active = await manager.list("active");
    const inactive = await manager.list("inactive");
    expect(active.length + inactive.length).toBe(all.length);
    for (const w of active) expect(w.active).toBe(true);
    for (const w of inactive) expect(w.active).toBe(false);
  });

  test("emits an event for each state change, always stamped with the ship name", async () => {
    const events: FleetEvent[] = [];
    const unsubscribe = manager.subscribe((e) => events.push(e));
    try {
      const created = await manager.create({ url: sourceRepo, repoName: "repo", name: "ws-events", branch: "main" });
      const repoName = created.repoName;
      await manager.activate(repoName, "ws-events");
      await manager.switchBranch(repoName, "ws-events", { branch: "feature" });
      await manager.deactivate(repoName, "ws-events");
      await manager.remove(repoName, "ws-events");
    } finally {
      unsubscribe();
    }

    expect(events.map((e) => e.type)).toEqual([
      "workspace.created",
      "workspace.activated",
      "workspace.branch_changed",
      "workspace.deactivated",
      "workspace.removed",
    ]);
    for (const event of events) expect(event.ship).toBe("test-ship");

    // Spot-check embedded summaries reflect the resulting state.
    const activated = events.find((e) => e.type === "workspace.activated");
    if (activated && activated.type === "workspace.activated") {
      expect(activated.workspace.active).toBe(true);
    }
    const branchChanged = events.find((e) => e.type === "workspace.branch_changed");
    if (branchChanged && branchChanged.type === "workspace.branch_changed") {
      expect(branchChanged.workspace.branch).toBe("feature");
    }

    // The unsubscribe should stop further delivery.
    const before = events.length;
    await manager.create({ url: sourceRepo, repoName: "repo", name: "ws-events-2", branch: "main" });
    expect(events.length).toBe(before);
  });

  test("diffSummary counts working-tree changes and commits ahead", async () => {
    const summary = await manager.create({ url: sourceRepo, repoName: "repo", name: "ws-diff", branch: "main" });
    await manager.activate(summary.repoName, "ws-diff");

    const wsDir = manager.workspaceDir(summary.repoName, "ws-diff");
    const git = new Git({ cwd: wsDir });
    await git.setConfig("user.email", "test@example.com");
    await git.setConfig("user.name", "Test");

    // One commit ahead of origin/main…
    await Bun.write(join(wsDir, "README.md"), "hello\nsecond\n");
    await git.add();
    await git.commit("second");
    // …plus an uncommitted edit on top.
    await Bun.write(join(wsDir, "README.md"), "hello\nsecond\nthird\n");

    const status = await manager.get(summary.repoName, "ws-diff");
    expect(status.state).toBe("active");
    if (status.state === "active") {
      expect(status.diff.added).toBeGreaterThan(0);
      expect(status.diff.commits).toBeGreaterThanOrEqual(1);
    }

    await manager.remove(summary.repoName, "ws-diff");
  });

  test("create places the clone under the given repoName, not the URL basename", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet-ship-proj-"));
    const projRepo = join(base, "proj.git");
    try {
      const git = await Git.init(projRepo, { initialBranch: "main" });
      await Bun.write(join(projRepo, "README.md"), "hi\n");
      await git.add();
      await git.setConfig("user.email", "test@example.com");
      await git.setConfig("user.name", "Test");
      await git.commit("initial");

      const summary = await manager.create({ url: projRepo, repoName: "my-proj", name: "c1", branch: "main" });
      expect(summary.repoName).toBe("my-proj");
      expect(await manager.has("my-proj", "c1")).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("list skips directories that are not git working trees", async () => {
    await mkdir(join(fleetDirectory, "junkrepo", "notaworkspace"), { recursive: true });
    const all = await manager.list();
    expect(all.some((w) => w.name === "notaworkspace")).toBe(false);
  });
});
