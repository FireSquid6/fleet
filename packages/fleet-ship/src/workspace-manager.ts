import { lstat, readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Git, GitError, type DiffOptions } from "git-bun";
import { Tmux } from "tmux-bun";
import {
  FleetIdentifierSchema,
  CreateWorkspaceRequestSchema,
  type CreateWorkspaceRequest,
  type AgentStatus,
  type FleetEvent,
  type FleetShipConfig,
  type WorkspaceDiff,
  type WorkspaceRefs,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "fleet-protocol";
import {
  ContainedPathError,
  CloneDestinationExistsError,
  assertCloneDestinationAvailable,
  containedPath,
  existingRepoPath,
  existingWorkspacePath,
} from "./contained-path";
import { WORKSPACE_TMUX_NAMESPACE, workspaceSessionName } from "./workspace-session";

export interface WorkspaceTmux {
  hasSession(name: string): Promise<boolean>;
  newSession(options: { name: string; dir: string }): Promise<unknown>;
  session(name: string): { kill(): Promise<void> };
}

/** A typed error carrying the HTTP status the API layer should map it to. */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export interface SwitchBranchOptions {
  readonly branch: string;
}

export interface RemoveOptions {
  /** With `false`, refuse to remove a workspace holding work no remote has. */
  readonly force?: boolean;
}

export interface InitAgentOptions {
  readonly model: string;
  readonly provider: string;
  readonly harness: string;
}

export interface RefsOptions {
  /** How many recent commits to return. Defaults to {@link RECENT_COMMIT_COUNT}. */
  readonly commits?: number;
}

/** Depth of the commit list in `refs` — deep enough to pick "last N" from. */
export const RECENT_COMMIT_COUNT = 20;

/** Branch names ranked by how likely they are to be the repo's integration branch. */
const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "origin/main", "origin/master"];

function defaultBranch(names: readonly string[]): string | null {
  return DEFAULT_BRANCH_CANDIDATES.find((candidate) => names.includes(candidate)) ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `work`, removing `dir` again if it throws — including when a failed `git clone`
 * leaves the destination behind, which it does whenever it gets as far as the
 * checkout. Without that, one failure makes the `(repoName, name)` slot a permanent
 * `409`. `assertCloneDestinationAvailable` proved `dir` did not exist, so removing it
 * can only undo our own work.
 */
async function withDestinationRollback<T>(dir: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (cleanup) {
      // Report both: the original failure explains what went wrong, and a rollback
      // that fails leaves the slot genuinely wedged until an operator removes `dir`,
      // which is a server-side fault however the original failure was classified.
      throw new WorkspaceError(
        `${messageOf(error)} (and the partial clone at ${dir} could not be removed: ${messageOf(cleanup)})`,
        500,
        { cause: error },
      );
    }
    throw error;
  }
}

async function unrecoverableWork(git: Git): Promise<string[]> {
  const held: string[] = [];

  const status = await git.status();
  if (!status.clean) held.push(plural(status.files.length, "uncommitted file"));

  const unpushed = await git.command.tryRun(["log", "--branches", "--not", "--remotes", "--format=%H"]);
  if (unpushed.exitCode !== 0) {
    held.push(`unpushed commits could not be counted: ${unpushed.stderr.trim() || "git failed"}`);
  } else {
    const commits = unpushed.stdout.split("\n").filter((line) => line.length > 0).length;
    if (commits > 0) held.push(`${plural(commits, "commit")} not on any remote`);
  }

  if ((await git.command.tryRun(["rev-parse", "--verify", "--quiet", "refs/stash"])).exitCode === 0) {
    held.push("a stash");
  }

  return held;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Clone `url` into `dir` and put the workspace on `branch`, a name the remote did not
 * advertise as either a branch or a tag. The clone's own refs decide whether `branch`
 * tracks `origin/<branch>` or is forked off what the clone checked out. Callers own
 * rolling `dir` back if this throws.
 */
async function cloneOntoBranch(url: string, dir: string, branch: string): Promise<void> {
  const git = await Git.clone(url, dir);
  // A clone can exit 0 with nothing checked out — an empty remote, or one whose HEAD
  // names a deleted branch — and a branch forked off that has no commits, so every
  // later git read on the workspace fails. Refuse it while the mess is still ours.
  if ((await git.command.tryRun(["rev-parse", "--verify", "HEAD"])).exitCode !== 0) {
    throw new WorkspaceError(`remote has no usable HEAD to create branch "${branch}" from`, 400);
  }
  if ((await git.currentBranch()) === branch) return;

  // The probe's answer can be stale — `branch` may have been pushed since — so decide
  // from the refs the clone fetched. Naming `origin/<branch>` as the start point sets
  // upstream and, unlike a bare `switch`, does not depend on `checkout.guess`.
  const remotes = await git.branches({ remote: true });
  const tracked = remotes.some((remote) => remote.name === `origin/${branch}`);
  try {
    await git.switchBranch(branch, {
      create: true,
      startPoint: tracked ? `origin/${branch}` : undefined,
    });
  } catch (error) {
    // The clone already succeeded, so git refusing the branch means a name it will not
    // take (`HEAD`, `a..b`, or one colliding with an existing ref) — the caller's
    // input, not a server fault. Scoped to this step so a failed clone stays a 500.
    if (error instanceof GitError) {
      const detail = error.stderr.trim() === "" ? error.message : error.stderr.trim();
      throw new WorkspaceError(`could not create branch "${branch}": ${detail}`, 400, {
        cause: error,
      });
    }
    throw error;
  }
}

export class WorkspaceManager {
  private readonly tmux: WorkspaceTmux;

  private readonly listeners = new Set<(event: FleetEvent) => void>();

  // Agent status is runtime state tied to a workspace's tmux session, so it
  // lives in memory alongside it (not persisted) and is cleared when the
  // session goes away — see deactivate()/remove().
  private readonly agentStatuses = new Map<string, AgentStatus>();

  constructor(
    private readonly config: FleetShipConfig,
    tmux: WorkspaceTmux = new Tmux({ namespace: WORKSPACE_TMUX_NAMESPACE }),
  ) {
    this.tmux = tmux;
  }

  /**
   * Subscribe to workspace and agent status changes. Returns an unsubscribe
   * function.
   */
  subscribe(listener: (event: FleetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A `sync` event snapshotting the current workspaces (sent to new subscribers). */
  async snapshotEvent(): Promise<FleetEvent> {
    const workspaces = await this.list();
    return { type: "sync", ...this.stamp(), workspaces };
  }

  private emit(event: FleetEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private stamp(): { ship: string; at: string } {
    return { ship: this.config.name, at: new Date().toISOString() };
  }

  private key(repoName: string, name: string): string {
    this.validateIdentifiers(repoName, name);
    return `${repoName}/${name}`;
  }

  sessionName(repoName: string, name: string): string {
    this.validateIdentifiers(repoName, name);
    return workspaceSessionName(repoName, name);
  }

  workspaceDir(repoName: string, name: string): string {
    this.validateIdentifiers(repoName, name);
    return containedPath(this.config.fleetDirectory, repoName, name);
  }

  /** Whether the workspace directory exists on disk (is a git working tree). */
  async has(repoName: string, name: string): Promise<boolean> {
    try {
      await this.requireWorkspace(repoName, name);
      return true;
    } catch (error) {
      if (error instanceof WorkspaceError && error.status === 404) return false;
      throw error;
    }
  }

  private async requireWorkspace(repoName: string, name: string): Promise<string> {
    this.validateIdentifiers(repoName, name);
    try {
      const dir = await existingWorkspacePath(this.config.fleetDirectory, repoName, name);
      const gitStat = await lstat(containedPath(dir, ".git"));
      if (!gitStat.isDirectory()) throw new ContainedPathError(`git metadata is not a directory: ${dir}/.git`);
      return existingWorkspacePath(this.config.fleetDirectory, repoName, name);
    } catch (error) {
      if (error instanceof ContainedPathError) throw new WorkspaceError(error.message, 400);
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new WorkspaceError(`workspace not found: ${repoName}/${name}`, 404);
      }
      throw error;
    }
  }

  private validateIdentifiers(repoName: string, name: string): void {
    for (const [label, value] of [["repo", repoName], ["workspace", name]] as const) {
      const result = FleetIdentifierSchema.safeParse(value);
      if (!result.success) throw new WorkspaceError(`invalid ${label} identifier`, 400);
    }
  }

  private async directoryNames(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && FleetIdentifierSchema.safeParse(entry.name).success)
        .map((entry) => entry.name);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
      throw error;
    }
  }

  private async existingDirectoryNames(repoName?: string): Promise<string[]> {
    const parent = repoName === undefined
      ? this.config.fleetDirectory
      : await existingRepoPath(this.config.fleetDirectory, repoName);
    const names = await this.directoryNames(parent);
    const valid: string[] = [];
    for (const name of names) {
      try {
        if (repoName === undefined) {
          await existingRepoPath(this.config.fleetDirectory, name);
        } else {
          await existingWorkspacePath(this.config.fleetDirectory, repoName, name);
        }
        valid.push(name);
      } catch {
        // Disk entries are untrusted; invalid or raced entries are omitted.
      }
    }
    return valid;
  }

  async list(filter?: "active" | "inactive"): Promise<WorkspaceSummary[]> {
    const summaries: WorkspaceSummary[] = [];

    const repoNames = await this.existingDirectoryNames();
    for (const repoName of repoNames) {
      const names = await this.existingDirectoryNames(repoName);
      for (const name of names) {
        try {
          if (!(await this.has(repoName, name))) continue;
          summaries.push(await this.summarize(repoName, name));
        } catch {
          // A disk entry can be replaced between discovery and use; omit it.
        }
      }
    }

    if (filter === undefined) return summaries;
    return summaries.filter((s) => (filter === "active" ? s.active : !s.active));
  }

  async get(repoName: string, name: string): Promise<WorkspaceStatus> {
    const dir = await this.requireWorkspace(repoName, name);
    const git = new Git({ cwd: dir });
    const branch = await git.currentBranch();
    const active = await this.tmux.hasSession(this.sessionName(repoName, name));

    if (!active) {
      return { state: "inactive", repoName, name, branch };
    }

    const diff = await this.diffSummary(git);
    return {
      state: "active",
      repoName,
      name,
      branch,
      diff,
      agent: this.agentStatuses.get(this.key(repoName, name)) ?? null,
      issue: null,
      mergeRequest: null,
      ship: this.config.name,
    };
  }

  /**
   * Raw `git diff` text for the workspace, narrowed by {@link DiffOptions}. Works
   * on the on-disk tree regardless of whether the workspace is active, so callers
   * can inspect changes without an up tmux session.
   */
  async diff(repoName: string, name: string, options: DiffOptions = {}): Promise<string> {
    const dir = await this.requireWorkspace(repoName, name);
    const git = new Git({ cwd: dir });
    return git.diff(options);
  }

  /**
   * The branches and recent commits a caller can diff the workspace against.
   * Remote-tracking branches are included so a workspace can be compared with an
   * integration branch it has no local copy of.
   */
  async refs(repoName: string, name: string, options: RefsOptions = {}): Promise<WorkspaceRefs> {
    const dir = await this.requireWorkspace(repoName, name);
    const git = new Git({ cwd: dir });
    const [current, local, remote, log] = await Promise.all([
      git.currentBranch(),
      git.branches(),
      git.branches({ remote: true }),
      git.log({ maxCount: options.commits ?? RECENT_COMMIT_COUNT }),
    ]);

    const branches = [
      ...local.map((branch) => ({ name: branch.name, remote: false })),
      // `origin/HEAD` is a symbolic alias, not a ref worth offering as a target.
      // It shows up either as `origin/HEAD` or — when it is the remote's default
      // ref — abbreviated all the way down to a bare `origin`.
      ...remote
        .filter((branch) => !branch.name.endsWith("/HEAD") && branch.name.includes("/"))
        .map((branch) => ({ name: branch.name, remote: true })),
    ].filter((branch) => branch.name.length > 0);

    return {
      current,
      defaultBranch: defaultBranch(branches.map((b) => b.name)),
      branches,
      commits: log.map((commit) => ({
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
      })),
    };
  }

  /**
   * Attach (or reset) the agent session on an active workspace, seeding its
   * status to `idle`. Requires an up tmux session — the agent lives in it.
   */
  async initAgent(repoName: string, name: string, options: InitAgentOptions): Promise<AgentStatus> {
    await this.requireWorkspace(repoName, name);
    if (!(await this.tmux.hasSession(this.sessionName(repoName, name)))) {
      throw new WorkspaceError(`workspace not active: ${repoName}/${name}`, 400);
    }

    const status: AgentStatus = {
      state: "idle",
      description: `Created session at ${new Date().toISOString()}`,
      model: options.model,
      provider: options.provider,
      harness: options.harness,
    };
    this.agentStatuses.set(this.key(repoName, name), status);
    const workspace = await this.summarize(repoName, name);
    this.emit({ type: "workspace.agent_status_changed", ...this.stamp(), workspace });
    return status;
  }

  agentStatus(repoName: string, name: string): AgentStatus | null {
    this.validateIdentifiers(repoName, name);
    return this.agentStatuses.get(this.key(repoName, name)) ?? null;
  }

  /**
   * Update the live agent status (state + description), preserving the session's
   * model/provider/harness. Requires a session started by `initAgent` first.
   */
  async updateAgentStatus(
    repoName: string,
    name: string,
    update: { state: AgentStatus["state"]; description: string },
  ): Promise<AgentStatus> {
    await this.requireWorkspace(repoName, name);
    const current = this.agentStatuses.get(this.key(repoName, name));
    if (current === undefined) {
      throw new WorkspaceError(`agent not initialized: ${repoName}/${name}`, 400);
    }

    const status: AgentStatus = { ...current, state: update.state, description: update.description };
    this.agentStatuses.set(this.key(repoName, name), status);
    const workspace = await this.summarize(repoName, name);
    this.emit({ type: "workspace.agent_status_changed", ...this.stamp(), workspace });
    return status;
  }

  async create(options: CreateWorkspaceRequest): Promise<WorkspaceSummary> {
    const parsed = CreateWorkspaceRequestSchema.safeParse(options);
    if (!parsed.success) throw new WorkspaceError("invalid workspace create request", 400);
    const { url, repoName, name } = parsed.data;
    // The protocol only types `branch` as a string, so a blank one reaches here. This
    // trimmed value is the probe pattern, the ref git resolves, and what clients see.
    const branch = parsed.data.branch.trim();
    if (branch.length === 0) throw new WorkspaceError("branch must not be empty", 400);
    let dir: string;
    try {
      dir = await assertCloneDestinationAvailable(this.config.fleetDirectory, repoName, name);
    } catch (error) {
      if (error instanceof CloneDestinationExistsError) throw new WorkspaceError(error.message, 409);
      if (error instanceof ContainedPathError) throw new WorkspaceError(error.message, 400);
      throw error;
    }

    // A failing probe propagates as a GitError instead of being read as "the ref
    // doesn't exist", so a network blip can't put the workspace on a branch forked
    // off the wrong place. `cwd` is where `Git.clone` runs, so both read one config.
    const advertised = await Git.lsRemote(url, {
      cwd: dirname(dir),
      heads: true,
      tags: true,
      pattern: branch,
    });
    const isUpstreamRef = advertised.some(
      (ref) => ref.ref === `refs/heads/${branch}` || ref.ref === `refs/tags/${branch}`,
    );
    await withDestinationRollback(dir, async () => {
      if (isUpstreamRef) await Git.clone(url, dir, { branch });
      else await cloneOntoBranch(url, dir, branch);
    });

    const summary: WorkspaceSummary = { repoName, name, branch, active: false, agent: null };
    this.emit({ type: "workspace.created", ...this.stamp(), workspace: summary });
    return summary;
  }

  async switchBranch(repoName: string, name: string, options: SwitchBranchOptions): Promise<void> {
    const dir = await this.requireWorkspace(repoName, name);
    const git = new Git({ cwd: dir });
    await git.switchBranch(options.branch, { create: true });

    const workspace = await this.summarize(repoName, name);
    this.emit({ type: "workspace.branch_changed", ...this.stamp(), workspace });
  }

  async activate(repoName: string, name: string): Promise<void> {
    await this.requireWorkspace(repoName, name);
    const sessionName = this.sessionName(repoName, name);
    if (await this.tmux.hasSession(sessionName)) {
      throw new WorkspaceError(`workspace already active: ${repoName}/${name}`, 400);
    }
    const dir = await this.requireWorkspace(repoName, name);
    await this.tmux.newSession({ name: sessionName, dir });

    const workspace = await this.summarize(repoName, name);
    this.emit({ type: "workspace.activated", ...this.stamp(), workspace });
  }

  async deactivate(repoName: string, name: string): Promise<void> {
    await this.requireWorkspace(repoName, name);
    const sessionName = this.sessionName(repoName, name);
    if (!(await this.tmux.hasSession(sessionName))) {
      throw new WorkspaceError(`workspace not active: ${repoName}/${name}`, 400);
    }
    await this.tmux.session(sessionName).kill();
    this.agentStatuses.delete(this.key(repoName, name));

    const workspace = await this.summarize(repoName, name);
    this.emit({ type: "workspace.deactivated", ...this.stamp(), workspace });
  }

  async remove(repoName: string, name: string, options: RemoveOptions = {}): Promise<void> {
    const dir = await this.requireWorkspace(repoName, name);

    // Capture the branch before deleting the directory so the `removed` event can
    // still identify the workspace's last-known state.
    const git = new Git({ cwd: dir });
    const branch = await git.currentBranch().catch(() => "");

    if (options.force === false) {
      const held = await unrecoverableWork(git);
      if (held.length > 0) {
        throw new WorkspaceError(
          `workspace ${repoName}/${name} holds work that is not on a remote: ${held.join("; ")}`,
          409,
        );
      }
    }

    const sessionName = this.sessionName(repoName, name);
    if (await this.tmux.hasSession(sessionName)) {
      await this.tmux.session(sessionName).kill();
    }
    const removalTarget = await this.requireWorkspace(repoName, name);
    await rm(removalTarget, { recursive: true, force: true });
    this.agentStatuses.delete(this.key(repoName, name));

    const workspace: WorkspaceSummary = { repoName, name, branch, active: false, agent: null };
    this.emit({ type: "workspace.removed", ...this.stamp(), workspace });
  }

  private async summarize(repoName: string, name: string): Promise<WorkspaceSummary> {
    const dir = await this.requireWorkspace(repoName, name);
    const git = new Git({ cwd: dir });
    const branch = await git.currentBranch();
    const active = await this.tmux.hasSession(this.sessionName(repoName, name));
    const agent = active ? this.agentStatuses.get(this.key(repoName, name)) ?? null : null;
    return { repoName, name, branch, active, agent };
  }

  private async diffSummary(git: Git): Promise<WorkspaceDiff> {
    const [numstat, status] = await Promise.all([
      git.command.run(["diff", "--numstat", "HEAD"]),
      git.status(),
    ]);

    let added = 0;
    let removed = 0;
    for (const line of numstat.split("\n")) {
      if (line.length === 0) continue;
      const parts = line.split("\t");
      const a = parts[0];
      const r = parts[1];
      if (a === undefined || r === undefined) continue;
      if (a === "-" || r === "-") continue; // binary file
      const aNum = Number.parseInt(a, 10);
      const rNum = Number.parseInt(r, 10);
      if (Number.isFinite(aNum)) added += aNum;
      if (Number.isFinite(rNum)) removed += rNum;
    }

    return { added, removed, commits: status.ahead };
  }
}
