/**
 * workspace-manager.ts — owns the on-disk workspace layout, the tmux namespace
 * that tracks active/inactive state, and the git operations on each workspace.
 *
 * A workspace is a git clone of a repo on a branch, living at
 * `<fleetDirectory>/<repo>/<name>`, where `<repo>` is the clone URL's basename
 * (`.git` stripped). It is identified by the `(repo, name)` pair.
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Git } from "git-bun";
import { Tmux } from "tmux-bun";
import type {
  FleetEvent,
  FleetShipConfig,
  WorkspaceDiff,
  WorkspaceStatus,
  WorkspaceSummary,
} from "fleet-protocol";

const TMUX_NAMESPACE = "fleet-ship";

/** A typed error carrying the HTTP status the API layer should map it to. */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface CreateWorkspaceOptions {
  readonly repo: string;
  readonly name: string;
  readonly branch: string;
}

export interface SwitchBranchOptions {
  readonly branch: string;
}

/** Derive the repo id (directory name) from a clone URL's basename, minus `.git`. */
function repoBasename(repoUrlOrName: string): string {
  const base = basename(repoUrlOrName);
  return base.endsWith(".git") ? base.slice(0, -".git".length) : base;
}

export class WorkspaceManager {
  private readonly tmux: Tmux;

  private readonly listeners = new Set<(event: FleetEvent) => void>();

  constructor(private readonly config: FleetShipConfig) {
    this.tmux = new Tmux({ namespace: TMUX_NAMESPACE, configFile: "/dev/null" });
  }

  /**
   * Subscribe to workspace state-change events (create/branch/activate/
   * deactivate/remove). Returns an unsubscribe function.
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

  /** Common event fields: the emitting ship's name and an ISO timestamp. */
  private stamp(): { ship: string; at: string } {
    return { ship: this.config.name, at: new Date().toISOString() };
  }

  /** Deterministic tmux session name for a `(repo, name)` pair. */
  sessionName(repo: string, name: string): string {
    const sanitize = (s: string) => s.replace(/[.:]/g, "-");
    return `${sanitize(repo)}__${sanitize(name)}`;
  }

  workspaceDir(repo: string, name: string): string {
    return join(this.config.fleetDirectory, repo, name);
  }

  /** Whether the workspace directory exists on disk (is a git working tree). */
  async has(repo: string, name: string): Promise<boolean> {
    try {
      const gitStat = await stat(join(this.workspaceDir(repo, name), ".git"));
      return gitStat.isDirectory() || gitStat.isFile();
    } catch {
      return false;
    }
  }

  async list(filter?: "active" | "inactive"): Promise<WorkspaceSummary[]> {
    const summaries: WorkspaceSummary[] = [];

    const repos = await this.safeReaddir(this.config.fleetDirectory);
    for (const repo of repos) {
      const repoDir = join(this.config.fleetDirectory, repo);
      const names = await this.safeReaddir(repoDir);
      for (const name of names) {
        if (!(await this.has(repo, name))) continue;
        const summary = await this.summarize(repo, name);
        summaries.push(summary);
      }
    }

    if (filter === undefined) return summaries;
    return summaries.filter((s) => (filter === "active" ? s.active : !s.active));
  }

  async get(repo: string, name: string): Promise<WorkspaceStatus> {
    if (!(await this.has(repo, name))) {
      throw new WorkspaceError(`workspace not found: ${repo}/${name}`, 404);
    }

    const dir = this.workspaceDir(repo, name);
    const git = new Git({ cwd: dir });
    const branch = await git.currentBranch();
    const active = await this.tmux.hasSession(this.sessionName(repo, name));

    if (!active) {
      return { state: "inactive", repo, name, branch };
    }

    const diff = await this.diffSummary(git);
    return {
      state: "active",
      repo,
      name,
      branch,
      diff,
      issue: null,
      mergeRequest: null,
      agentProvider: null,
      agentProfile: null,
      agentStatus: null,
      ship: this.config.name,
    };
  }

  async create(options: CreateWorkspaceOptions): Promise<WorkspaceSummary> {
    const repo = repoBasename(options.repo);
    const { name, branch } = options;

    if (await this.has(repo, name)) {
      throw new WorkspaceError(`workspace already exists: ${repo}/${name}`, 409);
    }

    const repoDir = join(this.config.fleetDirectory, repo);
    await mkdir(repoDir, { recursive: true });

    const dir = this.workspaceDir(repo, name);
    await Git.clone(options.repo, dir, { branch });

    const summary: WorkspaceSummary = { repo, name, branch, active: false };
    this.emit({ type: "workspace.created", ...this.stamp(), workspace: summary });
    return summary;
  }

  async switchBranch(repo: string, name: string, options: SwitchBranchOptions): Promise<void> {
    if (!(await this.has(repo, name))) {
      throw new WorkspaceError(`workspace not found: ${repo}/${name}`, 404);
    }
    const git = new Git({ cwd: this.workspaceDir(repo, name) });
    await git.switchBranch(options.branch, { create: true });

    const workspace = await this.summarize(repo, name);
    this.emit({ type: "workspace.branch_changed", ...this.stamp(), workspace });
  }

  async activate(repo: string, name: string): Promise<void> {
    if (!(await this.has(repo, name))) {
      throw new WorkspaceError(`workspace not found: ${repo}/${name}`, 404);
    }
    const sessionName = this.sessionName(repo, name);
    if (await this.tmux.hasSession(sessionName)) {
      throw new WorkspaceError(`workspace already active: ${repo}/${name}`, 400);
    }
    await this.tmux.newSession({ name: sessionName, dir: this.workspaceDir(repo, name) });

    const workspace = await this.summarize(repo, name);
    this.emit({ type: "workspace.activated", ...this.stamp(), workspace });
  }

  async deactivate(repo: string, name: string): Promise<void> {
    if (!(await this.has(repo, name))) {
      throw new WorkspaceError(`workspace not found: ${repo}/${name}`, 404);
    }
    const sessionName = this.sessionName(repo, name);
    if (!(await this.tmux.hasSession(sessionName))) {
      throw new WorkspaceError(`workspace not active: ${repo}/${name}`, 400);
    }
    await this.tmux.session(sessionName).kill();

    const workspace = await this.summarize(repo, name);
    this.emit({ type: "workspace.deactivated", ...this.stamp(), workspace });
  }

  async remove(repo: string, name: string): Promise<void> {
    if (!(await this.has(repo, name))) {
      throw new WorkspaceError(`workspace not found: ${repo}/${name}`, 404);
    }

    // Capture the branch before deleting the directory so the `removed` event can
    // still identify the workspace's last-known state.
    const git = new Git({ cwd: this.workspaceDir(repo, name) });
    const branch = await git.currentBranch().catch(() => "");

    const sessionName = this.sessionName(repo, name);
    if (await this.tmux.hasSession(sessionName)) {
      await this.tmux.session(sessionName).kill();
    }
    await rm(this.workspaceDir(repo, name), { recursive: true, force: true });

    const workspace: WorkspaceSummary = { repo, name, branch, active: false };
    this.emit({ type: "workspace.removed", ...this.stamp(), workspace });
  }

  private async summarize(repo: string, name: string): Promise<WorkspaceSummary> {
    const git = new Git({ cwd: this.workspaceDir(repo, name) });
    const branch = await git.currentBranch();
    const active = await this.tmux.hasSession(this.sessionName(repo, name));
    return { repo, name, branch, active };
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

  private async safeReaddir(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
