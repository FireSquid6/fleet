import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "git-bun";
import { WorkspaceManager, type WorkspaceTmux } from "../src/workspace-manager";

const gitAvailable = await (async () => {
  try {
    return (await Bun.$`git --version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
})();

const suite = gitAvailable ? describe : describe.skip;
if (!gitAvailable) console.warn("git not found on PATH — skipping non-forcing removal tests");

const noTmux: WorkspaceTmux = {
  hasSession: async () => false,
  newSession: async () => {},
  session: () => ({ kill: async () => {} }),
};

suite("WorkspaceManager.remove with force: false", () => {
  let fleetDirectory: string;
  let manager: WorkspaceManager;
  let sourceRepo: string;

  const workspace = async (name: string): Promise<Git> => {
    await manager.create({ url: sourceRepo, repoName: "repo", name, branch: "main" });
    const git = new Git({ cwd: manager.workspaceDir("repo", name) });
    await git.setConfig("user.email", "test@example.com");
    await git.setConfig("user.name", "Test");
    return git;
  };

  beforeAll(async () => {
    fleetDirectory = await mkdtemp(join(tmpdir(), "fleet-ship-force-fleet-"));
    manager = new WorkspaceManager({ fleetDirectory, port: 4700, name: "test-ship" }, noTmux);

    sourceRepo = await mkdtemp(join(tmpdir(), "fleet-ship-force-source-"));
    const git = await Git.init(sourceRepo, { initialBranch: "main" });
    await Bun.write(join(sourceRepo, "README.md"), "hello\n");
    await git.add();
    await git.setConfig("user.email", "test@example.com");
    await git.setConfig("user.name", "Test");
    await git.commit("initial commit");
  });

  afterAll(async () => {
    await rm(fleetDirectory, { recursive: true, force: true });
    await rm(sourceRepo, { recursive: true, force: true });
  });

  test("removes a workspace whose work is all on the remote", async () => {
    await workspace("clean");

    await manager.remove("repo", "clean", { force: false });

    expect(await manager.has("repo", "clean")).toBe(false);
  });

  test("refuses a workspace with uncommitted changes", async () => {
    await workspace("dirty");
    await Bun.write(join(manager.workspaceDir("repo", "dirty"), "README.md"), "changed\n");

    await expect(manager.remove("repo", "dirty", { force: false })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("1 uncommitted file"),
    });
    expect(await manager.has("repo", "dirty")).toBe(true);
  });

  test("refuses a workspace holding only untracked files", async () => {
    await workspace("untracked");
    await Bun.write(join(manager.workspaceDir("repo", "untracked"), "notes.md"), "wip\n");

    await expect(manager.remove("repo", "untracked", { force: false })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("1 uncommitted file"),
    });
    expect(await manager.has("repo", "untracked")).toBe(true);
  });

  test("refuses a commit that no remote has", async () => {
    const git = await workspace("ahead");
    await Bun.write(join(manager.workspaceDir("repo", "ahead"), "README.md"), "local\n");
    await git.add();
    await git.commit("local work");

    await expect(manager.remove("repo", "ahead", { force: false })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("1 commit not on any remote"),
    });
    expect(await manager.has("repo", "ahead")).toBe(true);
  });

  test("refuses a commit on a branch that is not checked out", async () => {
    const git = await workspace("side-branch");
    await git.switchBranch("side", { create: true });
    await Bun.write(join(manager.workspaceDir("repo", "side-branch"), "side.md"), "side\n");
    await git.add();
    await git.commit("side work");
    await git.switchBranch("main");

    expect((await git.status()).ahead).toBe(0);
    await expect(manager.remove("repo", "side-branch", { force: false })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("1 commit not on any remote"),
    });
    expect(await manager.has("repo", "side-branch")).toBe(true);
  });

  test("refuses a workspace with a stash", async () => {
    const git = await workspace("stashed");
    await Bun.write(join(manager.workspaceDir("repo", "stashed"), "README.md"), "stashed\n");
    await git.command.run(["stash", "push", "-m", "wip"]);

    expect((await git.status()).clean).toBe(true);
    await expect(manager.remove("repo", "stashed", { force: false })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("a stash"),
    });
    expect(await manager.has("repo", "stashed")).toBe(true);
  });

  test("reports every kind of held work at once", async () => {
    const git = await workspace("everything");
    await Bun.write(join(manager.workspaceDir("repo", "everything"), "README.md"), "committed\n");
    await git.add();
    await git.commit("local work");
    await Bun.write(join(manager.workspaceDir("repo", "everything"), "extra.md"), "extra\n");

    await expect(manager.remove("repo", "everything", { force: false })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("1 uncommitted file; 1 commit not on any remote"),
    });
  });

  test("removes held work when forced, and when force is not asked about", async () => {
    const forced = await workspace("forced");
    await Bun.write(join(manager.workspaceDir("repo", "forced"), "README.md"), "gone\n");
    await forced.add();
    await forced.commit("local work");

    await manager.remove("repo", "forced", { force: true });
    expect(await manager.has("repo", "forced")).toBe(false);

    const defaulted = await workspace("defaulted");
    await Bun.write(join(manager.workspaceDir("repo", "defaulted"), "README.md"), "gone\n");
    await defaulted.add();
    await defaulted.commit("local work");

    await manager.remove("repo", "defaulted");
    expect(await manager.has("repo", "defaulted")).toBe(false);
  });
});
