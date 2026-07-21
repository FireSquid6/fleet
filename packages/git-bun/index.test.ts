import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, GitError, parseBranches, parseLog, parseStatus, parseWorktrees } from "./index";

// Deterministic identity so commits never fail on missing user.name/user.email,
// regardless of the machine's global git config (the analog of tmux-bun's
// `configFile: "/dev/null"` determinism trick).
const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "git-bun test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "git-bun test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

// --- pure parsers — no git required, so these always run --------------------

describe("parseLog", () => {
  test("splits records by line and fields by the unit separator", () => {
    const S = String.fromCharCode(0x1f);
    const stdout = [
      ["abc123", "abc", "Ada", "ada@x.io", "1700000000", "first commit"].join(S),
      ["def456", "def", "Boo", "boo@x.io", "1700000100", "second: with, punctuation"].join(S),
    ].join("\n");
    const commits = parseLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: "abc123",
      shortSha: "abc",
      authorName: "Ada",
      authorEmail: "ada@x.io",
      authorDate: 1700000000,
      subject: "first commit",
    });
    expect(commits[1]?.subject).toBe("second: with, punctuation");
  });

  test("returns [] for empty output", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("parseStatus", () => {
  test("reads branch, ahead/behind, and changed/untracked files", () => {
    const stdout = [
      "# branch.oid abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
      "1 .M N... 100644 100644 100644 ccc ddd dirty.txt",
      "? untracked.txt",
    ].join("\n");
    const status = parseStatus(stdout);
    expect(status.branch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.clean).toBe(false);
    expect(status.files).toHaveLength(3);
    expect(status.files[0]).toMatchObject({ path: "staged.txt", staged: true });
    expect(status.files[1]).toMatchObject({ path: "dirty.txt", staged: false });
    expect(status.files[2]).toMatchObject({ path: "untracked.txt", code: "??", staged: false });
  });

  test("parses a rename entry's destination and original path", () => {
    const stdout = [
      "# branch.head main",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new-name.txt\told-name.txt",
    ].join("\n");
    const status = parseStatus(stdout);
    expect(status.files[0]).toMatchObject({
      path: "new-name.txt",
      origPath: "old-name.txt",
      staged: true,
    });
  });

  test("a clean tree reports clean=true and no files", () => {
    const status = parseStatus("# branch.head main\n# branch.ab +0 -0\n");
    expect(status.clean).toBe(true);
    expect(status.files).toEqual([]);
    expect(status.ahead).toBe(0);
  });

  test("detached HEAD leaves branch undefined", () => {
    const status = parseStatus("# branch.head (detached)\n");
    expect(status.branch).toBeUndefined();
  });
});

describe("parseWorktrees", () => {
  test("parses multiple worktree blocks", () => {
    const stdout = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "",
    ].join("\n");
    const wts = parseWorktrees(stdout);
    expect(wts).toHaveLength(2);
    expect(wts[0]).toMatchObject({ path: "/repo", branch: "main", detached: false });
    expect(wts[1]).toMatchObject({ path: "/repo-wt", detached: true });
    expect(wts[1]?.branch).toBeUndefined();
  });
});

describe("parseBranches", () => {
  test("marks the current branch and reads upstream when set", () => {
    const S = String.fromCharCode(0x1f);
    const stdout = [
      ["main", "aaa", "*", "origin/main"].join(S),
      ["feature", "bbb", " ", ""].join(S),
    ].join("\n");
    const branches = parseBranches(stdout);
    expect(branches[0]).toEqual({ name: "main", sha: "aaa", current: true, upstream: "origin/main" });
    expect(branches[1]).toEqual({ name: "feature", sha: "bbb", current: false, upstream: undefined });
  });
});

// --- end-to-end against a real git binary -----------------------------------

const gitAvailable = await (async () => {
  try {
    return (await Bun.$`git --version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
})();

const suite = gitAvailable ? describe : describe.skip;
if (!gitAvailable) {
  console.warn("git not found on PATH — skipping git-bun end-to-end tests");
}

suite("git-bun end-to-end", () => {
  let root: string; // throwaway parent dir holding all repos for the suite

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "git-bun-test-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("init creates a repo and returns a handle bound to it", async () => {
    const dir = join(root, "init-repo");
    const repo = await Git.init(dir, { initialBranch: "main", env: IDENTITY });
    expect(repo.cwd).toBe(dir);
    expect(await repo.isRepo()).toBe(true);
    // A fresh dir that was never init'd is not a repo.
    const bare = new Git({ cwd: root });
    expect(await bare.isRepo()).toBe(false);
  });

  test("add + commit records a commit and status goes clean", async () => {
    const dir = join(root, "commit-repo");
    const repo = await Git.init(dir, { initialBranch: "main", env: IDENTITY });

    await Bun.write(join(dir, "a.txt"), "hello\n");
    let status = await repo.status();
    expect(status.clean).toBe(false);
    expect(status.files.map((f) => f.path)).toContain("a.txt");

    await repo.add(".");
    const sha = await repo.commit("initial commit");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.headSha()).toBe(sha);
    expect(await repo.currentBranch()).toBe("main");

    status = await repo.status();
    expect(status.clean).toBe(true);

    const log = await repo.log();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ sha, subject: "initial commit", authorName: "git-bun test" });
  });

  test("diff includes untracked files as synthesized add-file patches", async () => {
    const dir = join(root, "diff-untracked-repo");
    const repo = await Git.init(dir, { initialBranch: "main", env: IDENTITY });

    await Bun.write(join(dir, "tracked.txt"), "one\ntwo\n");
    await repo.add(".");
    await repo.commit("initial commit");

    // Modify the tracked file (unstaged) and create a brand-new untracked file.
    await Bun.write(join(dir, "tracked.txt"), "one\ntwo changed\n");
    await Bun.write(join(dir, "brand-new.txt"), "fresh line\n");

    // Plain `git diff HEAD` never reports the untracked file.
    const plain = await repo.diff({ range: "HEAD" });
    expect(plain).toContain("tracked.txt");
    expect(plain).not.toContain("brand-new.txt");

    // With includeUntracked it is appended as a `new file` add-diff.
    const full = await repo.diff({ range: "HEAD", includeUntracked: true });
    expect(full).toContain("tracked.txt");
    expect(full).toContain("+two changed");
    expect(full).toContain("brand-new.txt");
    expect(full).toContain("+fresh line");
    expect(full).toContain("new file");
  });

  test("branches can be created, listed, switched, and deleted", async () => {
    const dir = join(root, "branch-repo");
    const repo = await Git.init(dir, { initialBranch: "main", env: IDENTITY });
    await Bun.write(join(dir, "a.txt"), "x\n");
    await repo.add(".");
    await repo.commit("base");

    await repo.createBranch("feature");
    let names = (await repo.branches()).map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("feature");

    await repo.switchBranch("feature");
    expect(await repo.currentBranch()).toBe("feature");
    expect((await repo.branches()).find((b) => b.name === "feature")?.current).toBe(true);

    // checkout with create is the other entry point.
    await repo.checkout("second", { create: true });
    expect(await repo.currentBranch()).toBe("second");

    await repo.switchBranch("main");
    await repo.deleteBranch("feature", { force: true });
    names = (await repo.branches()).map((b) => b.name);
    expect(names).not.toContain("feature");
  });

  test("worktreeAdd returns a Git handle bound to the new directory", async () => {
    const dir = join(root, "wt-main");
    const repo = await Git.init(dir, { initialBranch: "main", env: IDENTITY });
    await Bun.write(join(dir, "a.txt"), "x\n");
    await repo.add(".");
    await repo.commit("base");

    const wtPath = join(root, "wt-agent");
    const agent = await repo.worktreeAdd(wtPath, { newBranch: "agent/1" });
    expect(agent.cwd).toBe(wtPath);
    expect(await agent.currentBranch()).toBe("agent/1");
    // A commit in the worktree is independent of the main repo's branch.
    await Bun.write(join(wtPath, "b.txt"), "y\n");
    await agent.add(".");
    const wtSha = await agent.commit("agent work");
    expect(await agent.headSha()).toBe(wtSha);
    expect(await repo.headSha()).not.toBe(wtSha);

    const list = await repo.worktreeList();
    const paths = list.map((w) => w.path);
    expect(paths.some((p) => p.endsWith("wt-main"))).toBe(true);
    expect(paths.some((p) => p.endsWith("wt-agent"))).toBe(true);

    await repo.worktreeRemove(wtPath, { force: true });
    expect((await repo.worktreeList()).some((w) => w.path.endsWith("wt-agent"))).toBe(false);
  });

  test("config can be set and read back; unset keys read as undefined", async () => {
    const dir = join(root, "config-repo");
    const repo = await Git.init(dir, { env: IDENTITY });
    await repo.setConfig("autosmith.enabled", "yes");
    expect(await repo.getConfig("autosmith.enabled")).toBe("yes");
    expect(await repo.getConfig("autosmith.missing")).toBeUndefined();
  });

  test("remotes can be added and listed", async () => {
    const dir = join(root, "remote-repo");
    const repo = await Git.init(dir, { env: IDENTITY });
    await repo.addRemote("origin", "https://example.com/x.git");
    const remotes = await repo.remotes();
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({
      name: "origin",
      fetchUrl: "https://example.com/x.git",
      pushUrl: "https://example.com/x.git",
    });
  });

  test("genuine failures surface as GitError", async () => {
    const dir = join(root, "err-repo");
    const repo = await Git.init(dir, { env: IDENTITY });
    // Resolving a nonexistent ref is a real failure, not an existence probe.
    await expect(repo.revParse("no-such-ref")).rejects.toThrow(GitError);
  });
});
