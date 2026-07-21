import { basename, dirname } from "node:path";
import type { GitBackend } from "./backend";
import { GitCommand, type GitCommandOptions } from "./command";
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  parseStatus,
  parseWorktrees,
} from "./format";
import type {
  AddOptions,
  BranchInfo,
  CheckoutOptions,
  CloneOptions,
  CommitInfo,
  CommitOptions,
  ConfigScope,
  CreateBranchOptions,
  DeleteBranchOptions,
  DiffOptions,
  FetchOptions,
  InitOptions,
  ListBranchesOptions,
  LogOptions,
  PullOptions,
  PushOptions,
  RemoteInfo,
  ResetOptions,
  RestoreOptions,
  ShowOptions,
  StatusInfo,
  SwitchOptions,
  WorktreeAddOptions,
  WorktreeInfo,
  WorktreeRemoveOptions,
} from "./types";

/** Construction options for {@link Git}. */
export type GitOptions = GitCommandOptions;

/**
 * Root handle for a single git working directory. Every operation reachable
 * from a `Git` instance runs against its `cwd`: the underlying
 * {@link GitCommand} injects `-C <cwd>` into every invocation, so no method can
 * touch a repository outside the directory this handle is bound to.
 *
 * Operations that produce a new working directory — {@link init}, {@link clone},
 * {@link worktreeAdd} — return a fresh `Git` bound to that directory, so an
 * orchestrator can hand the returned handle straight to whatever will work in it.
 */
export class Git {
  /**
   * The low-level command helper, exposed as an escape hatch for git
   * subcommands this library does not wrap. Calls still go through `-C <cwd>`,
   * so the working-directory guarantee holds here too.
   */
  readonly command: GitCommand;
  private readonly binary?: string;
  private readonly env?: Record<string, string>;

  constructor(options: GitOptions, backend?: GitBackend) {
    this.command = new GitCommand(options, backend);
    this.binary = options.binary;
    this.env = options.env;
  }

  get cwd(): string {
    return this.command.cwd;
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Initialize a new repository at `dir` and return a handle bound to it. The
   * creating command is scoped to `dirname(dir)` (which must already exist),
   * since `-C <dir>` would fail before `init` runs when `dir` does not yet exist.
   */
  static async init(dir: string, options: InitOptions = {}, backend?: GitBackend): Promise<Git> {
    const bootstrap = new GitCommand(
      { cwd: dirname(dir), binary: options.binary, env: options.env },
      backend,
    );
    const args = ["init"];
    if (options.bare) args.push("--bare");
    if (options.initialBranch !== undefined) args.push("-b", options.initialBranch);
    args.push(basename(dir));
    await bootstrap.run(args);
    return new Git({ cwd: dir, binary: options.binary, env: options.env }, backend);
  }

  /**
   * Clone `url` into `dir` and return a handle bound to it. Like {@link init},
   * the creating command is scoped to `dirname(dir)`, which must already exist.
   */
  static async clone(
    url: string,
    dir: string,
    options: CloneOptions = {},
    backend?: GitBackend,
  ): Promise<Git> {
    const bootstrap = new GitCommand(
      { cwd: dirname(dir), binary: options.binary, env: options.env },
      backend,
    );
    const args = ["clone"];
    if (options.branch !== undefined) args.push("--branch", options.branch);
    if (options.depth !== undefined) args.push("--depth", String(options.depth));
    if (options.origin !== undefined) args.push("--origin", options.origin);
    if (options.bare) args.push("--bare");
    args.push(url, basename(dir));
    await bootstrap.run(args);
    return new Git({ cwd: dir, binary: options.binary, env: options.env }, backend);
  }

  /** Whether `cwd` is inside a git working tree, via `rev-parse`. Never throws. */
  async isRepo(): Promise<boolean> {
    const res = await this.command.tryRun(["rev-parse", "--is-inside-work-tree"]);
    return res.exitCode === 0 && res.stdout.trim() === "true";
  }

  /** Absolute path to the repository root (`rev-parse --show-toplevel`). */
  async toplevel(): Promise<string> {
    return (await this.command.run(["rev-parse", "--show-toplevel"])).trim();
  }

  // --- inspect -------------------------------------------------------------

  /** Working-tree and index status, parsed from NUL-terminated porcelain v2. */
  async status(): Promise<StatusInfo> {
    const out = await this.command.run([
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]);
    return parseStatus(out);
  }

  /**
   * The current branch name (`branch --show-current`). Returns `""` when HEAD
   * is detached — use {@link headSha} to identify the commit in that case.
   */
  async currentBranch(): Promise<string> {
    return (await this.command.run(["branch", "--show-current"])).trim();
  }

  /** The commit hash HEAD points at (`rev-parse HEAD`). */
  async headSha(): Promise<string> {
    return (await this.command.run(["rev-parse", "HEAD"])).trim();
  }

  /** Resolve an arbitrary revision to its commit hash (`rev-parse <ref>`). */
  async revParse(ref: string): Promise<string> {
    return (await this.command.run(["rev-parse", ref])).trim();
  }

  /** Structured commit history (`log`), most recent first. */
  async log(options: LogOptions = {}): Promise<CommitInfo[]> {
    const args = ["log", `--pretty=format:${LOG_FORMAT}`];
    if (options.maxCount !== undefined) args.push("-n", String(options.maxCount));
    if (options.range !== undefined) args.push(options.range);
    if (options.paths !== undefined && options.paths.length > 0) args.push("--", ...options.paths);
    return parseLog(await this.command.run(args));
  }

  /** Raw diff text (`diff`). Returns the working-tree diff unless options narrow it. */
  async diff(options: DiffOptions = {}): Promise<string> {
    const args = ["diff"];
    if (options.staged) args.push("--staged");
    if (options.stat) args.push("--stat");
    if (options.nameOnly) args.push("--name-only");
    if (options.range !== undefined) args.push(options.range);
    if (options.paths !== undefined && options.paths.length > 0) args.push("--", ...options.paths);
    let out = await this.command.run(args);

    if (options.includeUntracked) {
      const listed = await this.command.run(["ls-files", "--others", "--exclude-standard"]);
      for (const file of listed.split("\n")) {
        if (file.length === 0) continue;
        // `diff --no-index /dev/null <file>` yields a proper `new file` patch block.
        // It exits 1 when the files differ (always, here), so tryRun and take stdout.
        const res = await this.command.tryRun(["diff", "--no-index", "/dev/null", file]);
        out += res.stdout;
      }
    }
    return out;
  }

  /** Raw output of `show` for a commit/object. */
  async show(ref: string, options: ShowOptions = {}): Promise<string> {
    const args = ["show"];
    if (options.stat) args.push("--stat");
    args.push(ref);
    return this.command.run(args);
  }

  // --- stage / commit ------------------------------------------------------

  /**
   * Stage paths (`add`). Defaults to staging everything in `cwd` (`.`). Pass
   * `{ all: true }` to stage all changes including deletions across the repo (`-A`).
   */
  async add(paths: string | string[] = ["."], options: AddOptions = {}): Promise<void> {
    const args = ["add"];
    if (options.all) {
      args.push("-A");
    } else {
      const list = Array.isArray(paths) ? paths : [paths];
      args.push(...(list.length > 0 ? list : ["."]));
    }
    await this.command.run(args);
  }

  /** Record a commit (`commit -m`) and return the new commit's hash. */
  async commit(message: string, options: CommitOptions = {}): Promise<string> {
    const args = ["commit", "-m", message];
    if (options.all) args.push("-a");
    if (options.allowEmpty) args.push("--allow-empty");
    if (options.amend) args.push("--amend");
    if (options.author !== undefined) args.push("--author", options.author);
    await this.command.run(args);
    // commit's own stdout isn't meant to be parsed; read the resulting hash back.
    return this.headSha();
  }

  /** Reset HEAD/index/working tree (`reset`). Path-scoped when `paths` is set. */
  async reset(options: ResetOptions = {}): Promise<void> {
    const args = ["reset"];
    if (options.paths !== undefined && options.paths.length > 0) {
      if (options.ref !== undefined) args.push(options.ref);
      args.push("--", ...options.paths);
    } else {
      if (options.mode !== undefined) args.push(`--${options.mode}`);
      if (options.ref !== undefined) args.push(options.ref);
    }
    await this.command.run(args);
  }

  /** Restore working-tree or index paths (`restore`). */
  async restore(paths: string | string[], options: RestoreOptions = {}): Promise<void> {
    const args = ["restore"];
    if (options.staged) args.push("--staged");
    if (options.source !== undefined) args.push("--source", options.source);
    const list = Array.isArray(paths) ? paths : [paths];
    args.push("--", ...list);
    await this.command.run(args);
  }

  // --- branches ------------------------------------------------------------

  /** List branches (`branch`), parsed into {@link BranchInfo}. */
  async branches(options: ListBranchesOptions = {}): Promise<BranchInfo[]> {
    const args = ["branch", `--format=${BRANCH_FORMAT}`];
    if (options.all) args.push("-a");
    else if (options.remote) args.push("-r");
    return parseBranches(await this.command.run(args));
  }

  /** Create a branch (`branch <name> [startPoint]`) without checking it out. */
  async createBranch(name: string, options: CreateBranchOptions = {}): Promise<void> {
    const args = ["branch", name];
    if (options.startPoint !== undefined) args.push(options.startPoint);
    await this.command.run(args);
  }

  /** Check out a branch/commit (`checkout`). Pass `{ create: true }` for `-b`. */
  async checkout(ref: string, options: CheckoutOptions = {}): Promise<void> {
    const args = ["checkout"];
    if (options.create) args.push("-b");
    args.push(ref);
    await this.command.run(args);
  }

  /**
   * Switch branches (`switch`) — the modern, less error-prone alternative to
   * {@link checkout}. Pass `{ create: true }` for `-c`, `{ detach: true }` for
   * a detached checkout.
   */
  async switchBranch(ref: string, options: SwitchOptions = {}): Promise<void> {
    const args = ["switch"];
    if (options.create) args.push("-c");
    if (options.detach) args.push("--detach");
    args.push(ref);
    await this.command.run(args);
  }

  /** Delete a branch (`branch -d`, or `-D` with `{ force: true }`). */
  async deleteBranch(name: string, options: DeleteBranchOptions = {}): Promise<void> {
    await this.command.run(["branch", options.force ? "-D" : "-d", name]);
  }

  // --- remotes / sync ------------------------------------------------------

  /** Fetch from a remote (`fetch`). */
  async fetch(options: FetchOptions = {}): Promise<void> {
    const args = ["fetch"];
    if (options.all) args.push("--all");
    if (options.prune) args.push("--prune");
    if (options.remote !== undefined) args.push(options.remote);
    await this.command.run(args);
  }

  /** Integrate a remote branch (`pull`). */
  async pull(options: PullOptions = {}): Promise<void> {
    const args = ["pull"];
    if (options.rebase) args.push("--rebase");
    if (options.remote !== undefined) args.push(options.remote);
    if (options.branch !== undefined) args.push(options.branch);
    await this.command.run(args);
  }

  /** Publish local commits (`push`). */
  async push(options: PushOptions = {}): Promise<void> {
    const args = ["push"];
    if (options.setUpstream) args.push("-u");
    if (options.force) args.push("--force");
    if (options.tags) args.push("--tags");
    if (options.remote !== undefined) args.push(options.remote);
    if (options.branch !== undefined) args.push(options.branch);
    await this.command.run(args);
  }

  /** List configured remotes (`remote -v`), one entry per remote name. */
  async remotes(): Promise<RemoteInfo[]> {
    const out = await this.command.run(["remote", "-v"]);
    const map = new Map<string, RemoteInfo>();
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      // Format: "<name>\t<url> (fetch|push)".
      const [name, rest] = line.split("\t");
      if (name === undefined || rest === undefined) continue;
      const match = /^(.*) \((fetch|push)\)$/.exec(rest);
      if (match === null) continue;
      const url = match[1] ?? "";
      const kind = match[2];
      const entry = map.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
      if (kind === "fetch") entry.fetchUrl = url;
      else entry.pushUrl = url;
      map.set(name, entry);
    }
    return [...map.values()];
  }

  /** Add a remote (`remote add <name> <url>`). */
  async addRemote(name: string, url: string): Promise<void> {
    await this.command.run(["remote", "add", name, url]);
  }

  // --- worktrees -----------------------------------------------------------

  /**
   * Add a worktree at `path` (`worktree add`) and return a `Git` handle bound
   * to it — the isolation primitive for giving a task its own working directory.
   * This runs from the current repo's `cwd`, so unlike {@link init}/{@link clone}
   * no parent-scoping is needed; only the returned handle points at `path`.
   */
  async worktreeAdd(path: string, options: WorktreeAddOptions = {}): Promise<Git> {
    const args = ["worktree", "add"];
    if (options.detach) args.push("--detach");
    if (options.force) args.push("--force");
    if (options.newBranch !== undefined) args.push("-b", options.newBranch);
    args.push(path);
    if (options.commitish !== undefined) args.push(options.commitish);
    await this.command.run(args);
    return new Git({ cwd: path, binary: this.binary, env: this.env });
  }

  /** List worktrees (`worktree list --porcelain`), including the main one. */
  async worktreeList(): Promise<WorktreeInfo[]> {
    return parseWorktrees(await this.command.run(["worktree", "list", "--porcelain"]));
  }

  /** Remove a worktree (`worktree remove`). Pass `{ force: true }` if dirty/locked. */
  async worktreeRemove(path: string, options: WorktreeRemoveOptions = {}): Promise<void> {
    const args = ["worktree", "remove"];
    if (options.force) args.push("--force");
    args.push(path);
    await this.command.run(args);
  }

  /** Prune stale worktree administrative entries (`worktree prune`). */
  async worktreePrune(): Promise<void> {
    await this.command.run(["worktree", "prune"]);
  }

  // --- config --------------------------------------------------------------

  /**
   * Read a config value (`config --get`). Returns `undefined` when the key is
   * unset, mirroring git's own "exit 1, no output" convention rather than throwing.
   */
  async getConfig(key: string, scope: ConfigScope = {}): Promise<string | undefined> {
    const args = ["config", "--get"];
    if (scope.global) args.push("--global");
    args.push(key);
    const res = await this.command.tryRun(args);
    if (res.exitCode !== 0) {
      // An unset key exits 1 with empty stderr; anything else is a real failure.
      if (res.stderr.trim().length === 0) return undefined;
      throw new Error(`git config --get failed: ${res.stderr.trim()}`);
    }
    return res.stdout.replace(/\n$/, "");
  }

  /** Set a config value (`config`). Pass `{ global: true }` for `--global`. */
  async setConfig(key: string, value: string, scope: ConfigScope = {}): Promise<void> {
    const args = ["config"];
    if (scope.global) args.push("--global");
    args.push(key, value);
    await this.command.run(args);
  }
}
