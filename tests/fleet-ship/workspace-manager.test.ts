import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "git-bun";
import { WorkspaceError, WorkspaceManager } from "../../apps/fleet-ship/src/workspace-manager";

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
      await manager.deactivate(w.repo, w.name).catch(() => {});
    }
    await rm(fleetDirectory, { recursive: true, force: true });
    await rm(sourceRepo, { recursive: true, force: true });
  });

  test("create clones a repo and leaves the workspace inactive", async () => {
    const summary = await manager.create({ repo: sourceRepo, name: "ws1", branch: "main" });
    expect(summary.name).toBe("ws1");
    expect(summary.branch).toBe("main");
    expect(summary.active).toBe(false);

    const status = await manager.get(summary.repo, "ws1");
    expect(status.state).toBe("inactive");
  });

  test("create rejects a duplicate (repo, name)", async () => {
    const summary = await manager.create({ repo: sourceRepo, name: "ws-dup", branch: "main" });
    await expect(manager.create({ repo: sourceRepo, name: "ws-dup", branch: "main" })).rejects.toThrow(
      WorkspaceError,
    );
  });

  test("activate/deactivate toggle tmux session state", async () => {
    const summary = await manager.create({ repo: sourceRepo, name: "ws2", branch: "main" });

    await manager.activate(summary.repo, "ws2");
    const activeStatus = await manager.get(summary.repo, "ws2");
    expect(activeStatus.state).toBe("active");
    if (activeStatus.state === "active") {
      expect(activeStatus.ship).toBe("test-ship");
      expect(activeStatus.diff).toEqual({ added: 0, removed: 0, commits: 0 });
    }

    await expect(manager.activate(summary.repo, "ws2")).rejects.toThrow(WorkspaceError);

    await manager.deactivate(summary.repo, "ws2");
    const inactiveStatus = await manager.get(summary.repo, "ws2");
    expect(inactiveStatus.state).toBe("inactive");

    await expect(manager.deactivate(summary.repo, "ws2")).rejects.toThrow(WorkspaceError);
  });

  test("remove deactivates and deletes the workspace directory", async () => {
    const summary = await manager.create({ repo: sourceRepo, name: "ws3", branch: "main" });
    await manager.activate(summary.repo, "ws3");
    await manager.remove(summary.repo, "ws3");

    expect(await manager.has(summary.repo, "ws3")).toBe(false);
    await expect(manager.get(summary.repo, "ws3")).rejects.toThrow(WorkspaceError);
  });

  test("list filters by active state", async () => {
    const all = await manager.list();
    const active = await manager.list("active");
    const inactive = await manager.list("inactive");
    expect(active.length + inactive.length).toBe(all.length);
    for (const w of active) expect(w.active).toBe(true);
    for (const w of inactive) expect(w.active).toBe(false);
  });
});
