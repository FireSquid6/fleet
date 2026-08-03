import { issueBranchName, type AgentState, type AgentStatus, type WorkspaceDiff, type WorkspaceRefs } from "fleet-protocol";
import type { DiffQuery } from "@/lib/diff/diff-target";
import type { FleetBridge } from "./provider";
import type {
  ArmoryFile,
  ArmoryManifest,
  ArmorySection,
  ArmoryShipState,
  ArmorySyncState,
  Repo,
  RepoBranch,
  RepoIssue,
  Ship,
  Workspace,
  WorkspaceDetail,
  WorkspaceEvent,
} from "./types";

const SHIPS: Ship[] = [
  { name: "forge-01", spec: "2×A100 · us-east-1", status: "online" },
  { name: "forge-02", spec: "2×A100 · us-east-1", status: "online" },
  { name: "atlas-7", spec: "8×H100 · eu-west-2", status: "online" },
  { name: "nimbus", spec: "32 vCPU · us-west-2", status: "online" },
];

function agent(state: AgentState, description: string, model = "claude-sonnet-4"): AgentStatus {
  return { state, description, model, provider: "anthropic", harness: "opencode" };
}

const SEED_WORKSPACES: Workspace[] = [
  { name: "ws-4f2a", repoName: "api-gateway", ship: "forge-01", branch: "main", active: true, agent: agent("building", "Implementing request routing") },
  { name: "ws-9c11", repoName: "api-gateway", ship: "forge-01", branch: "fix/rate-limit", active: true, agent: agent("verifying", "Running rate-limit tests") },
  { name: "ws-2e70", repoName: "api-gateway", ship: "atlas-7", branch: "release/2.3", active: false, agent: null },
  { name: "ws-6b83", repoName: "auth-svc", ship: "forge-02", branch: "main", active: true, agent: agent("planning", "Tracing token refresh flow") },
  { name: "ws-d904", repoName: "auth-svc", ship: "nimbus", branch: "feat/oauth-pkce", active: false, agent: null },
  { name: "ws-1a5f", repoName: "web-client", ship: "forge-01", branch: "main", active: true, agent: agent("awaiting", "Waiting for design confirmation") },
  { name: "ws-7fc2", repoName: "web-client", ship: "forge-02", branch: "feat/redesign", active: true, agent: agent("building", "Updating responsive navigation") },
  { name: "ws-3d18", repoName: "web-client", ship: "atlas-7", branch: "hotfix/csp", active: false, agent: null },
  { name: "ws-8e40", repoName: "billing", ship: "atlas-7", branch: "main", active: true, agent: agent("idle", "Ready for the next task") },
  { name: "ws-c227", repoName: "notifier", ship: "nimbus", branch: "main", active: false, agent: null },
  { name: "ws-5b96", repoName: "data-pipeline", ship: "forge-02", branch: "main", active: true, agent: agent("verifying", "Checking backfill consistency") },
  { name: "ws-0a3e", repoName: "data-pipeline", ship: "forge-02", branch: "spike/backfill", active: false, agent: null },
  { name: "ws-b6d1", repoName: "search-idx", ship: "atlas-7", branch: "main", active: true, agent: null },
  { name: "ws-e812", repoName: "mobile-bff", ship: "nimbus", branch: "feat/push", active: true, agent: agent("planning", "Reviewing push delivery paths") },
];

function key(repo: string, name: string): string {
  return `${repo}/${name}`;
}

function hashPid(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return 10000 + (Math.abs(h) % 89999);
}

function mockDiff(name: string): WorkspaceDiff {
  const h = Math.abs(hashPid(name));
  return { added: 8 + (h % 40), removed: h % 15, commits: 1 + (h % 3) };
}

/** A canned raw `git diff` (modified + deleted + new file) for the Diff tab in mock mode. */
const MOCK_DIFF = `diff --git a/src/server.ts b/src/server.ts
index 3a1f2b4..9c4e1a0 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -12,7 +12,8 @@ export function createServer(config: Config) {
   const app = new Elysia();

-  app.get("/health", () => "ok");
+  app.get("/health", () => ({ status: "ok" }));
+  app.get("/version", () => ({ version: config.version }));

   return app;
 }
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index 8b0a1c2..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,4 +0,0 @@
-// Deprecated entry point, superseded by server.ts.
-export function boot() {
-  throw new Error("removed");
-}
diff --git a/src/routes/version.ts b/src/routes/version.ts
new file mode 100644
index 0000000..d4e5f6a
--- /dev/null
+++ b/src/routes/version.ts
@@ -0,0 +1,5 @@
+import { Elysia } from "elysia";
+
+export const versionRoute = new Elysia().get("/version", () => ({
+  version: process.env.APP_VERSION ?? "dev",
+}));
`;

/** Appended when the diff target reaches past the working tree into history. */
const MOCK_HISTORY_DIFF = `diff --git a/src/config.ts b/src/config.ts
index 1c2d3e4..5f6a7b8 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -3,6 +3,7 @@ export interface Config {
   port: number;
   host: string;
+  version: string;
 }
`;

const MOCK_BRANCHES: WorkspaceRefs["branches"] = [
  { name: "main", remote: false },
  { name: "develop", remote: false },
  { name: "origin/main", remote: true },
  { name: "origin/develop", remote: true },
];

/**
 * What a repo's remote advertises, for the create-workspace branch picker. Kept
 * apart from `MOCK_BRANCHES`, which answers a *workspace's* refs and so carries
 * local/remote pairs rather than the `{ name, sha }` rows of the repo route.
 */
const MOCK_REPO_BRANCHES: RepoBranch[] = [
  { name: "develop", sha: "1f0a2b3c4d5e6f708192a3b4c5d6e7f809102132" },
  { name: "feat/oauth-pkce", sha: "2a1b3c4d5e6f708192a3b4c5d6e7f80910213243" },
  { name: "feat/redesign", sha: "3b2c4d5e6f708192a3b4c5d6e7f8091021324354" },
  { name: "fix/rate-limit", sha: "4c3d5e6f708192a3b4c5d6e7f80910213243546a" },
  { name: "hotfix/csp", sha: "5d4e6f708192a3b4c5d6e7f8091021324354657b" },
  { name: "main", sha: "6e5f708192a3b4c5d6e7f8091021324354657b8c" },
  { name: "release/2.3", sha: "7f60819a2b3c4d5e6f708192a3b4c5d6e7f80910" },
  { name: "spike/backfill", sha: "80719a2b3c4d5e6f708192a3b4c5d6e7f8091021" },
];

/**
 * Open issues for any provider-backed repo. The titles are deliberately varied —
 * punctuation that the slug has to collapse, and one long enough to be truncated —
 * so mock mode exercises the derived branch name the picker previews.
 */
const MOCK_ISSUES: RepoIssue[] = [
  {
    number: 12,
    title: "Better create workspace issue",
    author: "firesquid",
    url: "https://github.com/orchestra/repo/issues/12",
  },
  {
    number: 47,
    title: "Rate limiter drops the first request after a restart",
    author: "avery",
    url: "https://github.com/orchestra/repo/issues/47",
  },
  {
    number: 103,
    title: "Support OAuth 2.1 / PKCE (and drop the implicit flow)",
    author: "kai",
    url: "https://github.com/orchestra/repo/issues/103",
  },
  {
    number: 118,
    title:
      "Workspace terminal should reconnect automatically when the ship restarts instead of leaving a dead pane",
    author: "morgan",
    url: "https://github.com/orchestra/repo/issues/118",
  },
  {
    number: 204,
    title: "Docs: document the armory dotfile map",
    author: null,
    url: "https://github.com/orchestra/repo/issues/204",
  },
];

const MOCK_COMMITS: WorkspaceRefs["commits"] = [
  { sha: "9f1c0a2b3d4e5f60718293a4b5c6d7e8f9012345", shortSha: "9f1c0a2", subject: "Add the /version route" },
  { sha: "8e0b9a1c2d3e4f5061728394a5b6c7d8e9f01234", shortSha: "8e0b9a1", subject: "Return structured health output" },
  { sha: "7d9a8b0c1d2e3f4051627384a5b6c7d8e9f01233", shortSha: "7d9a8b0", subject: "Drop the legacy boot entry point" },
  { sha: "6c8970ab1c2d3e4f50617283a4b5c6d7e8f90122", shortSha: "6c8970a", subject: "Wire up the config loader" },
];

/**
 * A seed armory file. `contents` is what the viewer renders; everything the
 * manifest reports about the file (size, hash, section) is derived from it, so
 * the mock manifest and the mock file reads can never drift apart.
 */
interface SeedArmoryFile {
  readonly path: string;
  readonly contents: string;
  readonly encoding?: "utf8" | "base64";
  readonly mode?: number;
}

const SEED_ARMORY_FILES: SeedArmoryFile[] = [
  {
    path: "skills/pr-review/SKILL.md",
    contents: `---
name: pr-review
description: Review a pull request against the fleet's checklist.
---

Read the diff, then walk the checklist in \`checklist.md\` top to bottom.
Report findings as a list; do not push commits.
`,
  },
  {
    path: "skills/pr-review/checklist.md",
    contents: `- [ ] tests cover the new branch of behaviour
- [ ] no secrets or hostnames committed
- [ ] error paths return a mapped status, not a bare 500
`,
  },
  {
    path: "skills/deploy/SKILL.md",
    contents: `---
name: deploy
description: Roll a service out to the fleet.
---

Run \`scripts/rollout.sh <service>\`. It is idempotent and safe to re-run.
`,
  },
  {
    path: "skills/deploy/scripts/rollout.sh",
    contents: `#!/usr/bin/env bash
set -euo pipefail
service="\${1:?usage: rollout.sh <service>}"
echo "rolling out \${service}"
`,
    mode: 0o755,
  },
  {
    path: "plugins/opencode/plugin.json",
    contents: `{
  "name": "fleet-opencode",
  "version": "0.4.1",
  "entry": "src/index.ts"
}
`,
  },
  {
    path: "plugins/opencode/src/index.ts",
    contents: `export default {
  name: "fleet-opencode",
  hooks: {
    "session.start": () => console.log("fleet armory plugin loaded"),
  },
};
`,
  },
  {
    // Binary on purpose: the viewer must show a placeholder, never the bytes.
    path: "plugins/opencode/assets/icon.png",
    contents:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    encoding: "base64",
  },
  {
    path: "plugins/claude-code/settings.json",
    contents: `{
  "permissions": { "allow": ["Bash(bun test)", "Bash(bun run typecheck)"] }
}
`,
  },
  {
    path: "dotfiles/tmux.conf",
    contents: `set -g mouse on
set -g history-limit 50000
set -g status-style bg=default
`,
  },
  {
    path: "dotfiles/gitconfig",
    contents: `[user]
  name = fleet agent
[pull]
  rebase = true
`,
  },
  {
    path: "dotfiles/nvim/init.lua",
    contents: `vim.opt.number = true
vim.opt.expandtab = true
vim.opt.shiftwidth = 2
`,
  },
];

const SEED_DOTFILE_MAP: Record<string, string> = {
  "tmux.conf": "~/.tmux.conf",
  gitconfig: "~/.gitconfig",
  "nvim/init.lua": "~/.config/nvim/init.lua",
};

/**
 * A deterministic stand-in for a content hash. The mock never sees real bytes on
 * a real filesystem, and the UI only ever displays or compares these, so the one
 * property that matters is that the same input always yields the same 64 hex
 * characters.
 */
function fakeSha256(seed: string): string {
  let hash = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    for (const char of `${seed}#${round}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function armoryFile(seed: SeedArmoryFile): ArmoryFile {
  const encoding = seed.encoding ?? "utf8";
  return {
    path: seed.path,
    section: seed.path.split("/")[0] as ArmorySection,
    size: encoding === "base64" ? atob(seed.contents).length : new TextEncoder().encode(seed.contents).length,
    sha256: fakeSha256(seed.path),
    mode: seed.mode ?? 0o644,
    encoding,
    contents: seed.contents,
  };
}

/** The manifest revision, and the value an "in sync" ship reports. */
const ARMORY_REVISION = fakeSha256("armory-revision");
/** A revision from before the last edit, so a ship holding it reads as behind. */
const STALE_ARMORY_REVISION = fakeSha256("armory-revision-previous");

/**
 * Per-ship armory state, keyed by ship name: one in sync, one behind with an
 * install that hit a conflict, one that has never synced, and one whose last
 * sync failed. A ship added during the session has no seed and reports `null`,
 * which is also what the bridge returns for a ship it could not reach.
 */
const SEED_ARMORY_SHIP_STATES: Record<string, ArmorySyncState> = {
  "forge-01": {
    revision: ARMORY_REVISION,
    bridgeUrl: "http://bridge.local:4800",
    syncedAt: "2026-07-26T09:14:02.000Z",
    fileCount: SEED_ARMORY_FILES.length,
    install: {
      skillCount: 4,
      pluginCount: 4,
      dotfileCount: 3,
      removedCount: 0,
      conflicts: [],
      warnings: [],
      installedAt: "2026-07-26T09:14:03.000Z",
    },
    lastError: null,
  },
  "forge-02": {
    revision: STALE_ARMORY_REVISION,
    bridgeUrl: "http://bridge.local:4800",
    syncedAt: "2026-07-24T18:02:41.000Z",
    fileCount: SEED_ARMORY_FILES.length - 1,
    install: {
      skillCount: 4,
      pluginCount: 3,
      dotfileCount: 2,
      removedCount: 1,
      conflicts: ["~/.gitconfig"],
      warnings: ["plugins/opencode/assets/icon.png: skipped, unreadable on this host"],
      installedAt: "2026-07-24T18:02:44.000Z",
    },
    lastError: null,
  },
  "atlas-7": {
    revision: null,
    bridgeUrl: null,
    syncedAt: null,
    fileCount: 0,
    install: null,
    lastError: null,
  },
  nimbus: {
    revision: STALE_ARMORY_REVISION,
    bridgeUrl: "http://bridge.local:4800",
    syncedAt: "2026-07-20T11:47:12.000Z",
    fileCount: SEED_ARMORY_FILES.length - 1,
    install: null,
    lastError: "armory pull failed: bridge unreachable (502)",
  },
};

/** The one seed repo that is not provider-backed; see {@link seedRepos}. */
const CUSTOM_REPO = "notifier";

/**
 * Validate a create request's mutually exclusive branch source, mirroring the
 * bridge's own `branchSource` (`fleet-manager.ts`) — including the checks past
 * "one or the other": a blank branch and a non-integral issue number are 400s
 * there, and a mock that quietly accepts them would let a form ship a bug that
 * only the real bridge would catch.
 */
function branchSource(input: { branch?: string; issueNumber?: number }): { branch: string } | { issueNumber: number } {
  if (input.branch !== undefined && input.issueNumber !== undefined) {
    throw new Error("a workspace is created from a branch or an issue, not both");
  }
  if (input.branch !== undefined) {
    const branch = input.branch.trim();
    if (branch.length === 0) throw new Error("branch must not be empty");
    return { branch };
  }
  if (input.issueNumber !== undefined) {
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
      throw new Error("issueNumber must be a positive integer");
    }
    return { issueNumber: input.issueNumber };
  }
  throw new Error("a workspace needs either a branch or an issue to start from");
}

/**
 * All but one seed repo are `github`, so the issue picker has something to show;
 * the odd one out is a plain git remote, which is what makes the picker's
 * "this provider cannot list issues" path reachable in mock mode.
 */
function seedRepos(): Repo[] {
  const names: string[] = [];
  for (const w of SEED_WORKSPACES) {
    if (!names.includes(w.repoName)) names.push(w.repoName);
  }
  return names.map((name) =>
    name === CUSTOM_REPO
      ? { name, url: `git@git.internal:orchestra/${name}.git`, provider: "custom" }
      : { name, url: `git@github.com:orchestra/${name}.git`, provider: "github" },
  );
}

export class MockFleetBridge implements FleetBridge {
  private readonly workspaces: Workspace[] = SEED_WORKSPACES.map((w) => ({ ...w }));
  private readonly ships: Ship[] = SHIPS.map((s) => ({ ...s }));
  private readonly repos: Repo[] = seedRepos();
  private readonly armory: ArmoryFile[] = SEED_ARMORY_FILES.map(armoryFile);
  private readonly workspaceListeners = new Set<(event: WorkspaceEvent) => void>();

  private emit(event: WorkspaceEvent): void {
    for (const listener of this.workspaceListeners) listener(event);
  }

  private find(repo: string, name: string): Workspace {
    const w = this.workspaces.find((x) => x.repoName === repo && x.name === name);
    if (!w) throw new Error(`workspace not found: ${key(repo, name)}`);
    return w;
  }

  private repo(name: string): Repo {
    const repo = this.repos.find((r) => r.name === name);
    if (!repo) throw new Error(`repo not found: ${name}`);
    return repo;
  }

  /** A repo whose forge can answer issue queries — the rest 501 on the bridge. */
  private providerRepo(name: string): Repo {
    const repo = this.repo(name);
    if (repo.provider.toLowerCase() !== "github") {
      throw new Error(`provider "${repo.provider}" is not supported yet`);
    }
    return repo;
  }

  private issue(repoName: string, number: number): RepoIssue {
    this.providerRepo(repoName);
    const issue = MOCK_ISSUES.find((i) => i.number === number);
    if (!issue) throw new Error(`issue not found: #${number}`);
    return issue;
  }

  async listShips(): Promise<Ship[]> {
    return this.ships.map((s) => ({ ...s }));
  }

  async listRepos(): Promise<Repo[]> {
    return this.repos.map((r) => ({ ...r }));
  }

  async createRepo(input: { name: string; url: string; provider?: string }): Promise<Repo> {
    if (this.repos.some((r) => r.name === input.name)) {
      throw new Error(`repo already exists: ${input.name}`);
    }
    const repo: Repo = { name: input.name, url: input.url, provider: input.provider ?? "custom" };
    this.repos.push(repo);
    return { ...repo };
  }

  async deleteRepo(name: string): Promise<void> {
    const i = this.repos.findIndex((r) => r.name === name);
    if (i === -1) throw new Error(`repo not found: ${name}`);
    this.repos.splice(i, 1);
  }

  async listRepoBranches(name: string): Promise<RepoBranch[]> {
    this.repo(name);
    return MOCK_REPO_BRANCHES.map((b) => ({ ...b }));
  }

  async listRepoIssues(name: string): Promise<RepoIssue[]> {
    this.providerRepo(name);
    return MOCK_ISSUES.map((i) => ({ ...i }));
  }

  async createShip(url: string): Promise<Ship> {
    // The real bridge learns the ship's name from its first sync; approximate
    // that here by deriving a name from the URL host.
    const name = ((): string => {
      try {
        return new URL(url).hostname || url;
      } catch {
        return url;
      }
    })();
    if (this.ships.some((s) => s.name === name)) {
      throw new Error(`ship already exists: ${name}`);
    }
    const ship: Ship = { name, spec: url, status: "online" };
    this.ships.push(ship);
    return { ...ship };
  }

  async deleteShip(name: string): Promise<void> {
    const i = this.ships.findIndex((s) => s.name === name);
    if (i === -1) throw new Error(`ship not found: ${name}`);
    this.ships.splice(i, 1);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return this.workspaces.map((w) => ({ ...w }));
  }

  subscribeWorkspaces(listener: (event: WorkspaceEvent) => void): () => void {
    this.workspaceListeners.add(listener);
    listener({ type: "sync", at: new Date().toISOString(), workspaces: this.workspaces.map((w) => ({ ...w })) });
    return () => this.workspaceListeners.delete(listener);
  }

  async createWorkspace(input: {
    ship: string;
    repoName: string;
    name: string;
    branch?: string;
    issueNumber?: number;
  }): Promise<Workspace> {
    const source = branchSource(input);
    if (!this.ships.some((s) => s.name === input.ship)) throw new Error(`unknown ship: ${input.ship}`);
    if (!this.repos.some((r) => r.name === input.repoName)) throw new Error(`unknown repo: ${input.repoName}`);
    if (this.workspaces.some((w) => w.repoName === input.repoName && w.name === input.name)) {
      throw new Error(`workspace already exists: ${key(input.repoName, input.name)}`);
    }
    // The bridge derives the branch from the issue and links it on the provider
    // before the ship ever sees the request; the workspace it returns is on that
    // branch, so the mock has to do the same or issue mode looks like a no-op.
    const branch =
      "branch" in source ? source.branch : issueBranchName(this.issue(input.repoName, source.issueNumber));
    const ws: Workspace = {
      ship: input.ship,
      repoName: input.repoName,
      name: input.name,
      branch,
      active: false,
      agent: null,
    };
    this.workspaces.push(ws);
    this.emit({ type: "workspace.created", at: new Date().toISOString(), workspace: { ...ws } });
    return { ...ws };
  }

  async getWorkspace(repo: string, name: string): Promise<WorkspaceDetail> {
    const w = this.find(repo, name);
    if (!w.active) {
      return { state: "inactive", repoName: w.repoName, name: w.name, branch: w.branch, ship: w.ship };
    }
    return {
      state: "active",
      repoName: w.repoName,
      name: w.name,
      branch: w.branch,
      diff: mockDiff(w.name),
      agent: w.agent,
      issue: null,
      mergeRequest: null,
      ship: w.ship,
    };
  }

  async getWorkspaceDiff(repo: string, name: string, query: DiffQuery): Promise<string> {
    this.find(repo, name);
    // Ranges other than the working tree get an extra file appended, so
    // switching diff targets visibly changes the result in mock mode.
    return query.range === "HEAD" ? MOCK_DIFF : MOCK_DIFF + MOCK_HISTORY_DIFF;
  }

  async getWorkspaceRefs(repo: string, name: string): Promise<WorkspaceRefs> {
    const workspace = this.find(repo, name);
    return {
      current: workspace.branch,
      defaultBranch: "main",
      branches: MOCK_BRANCHES.filter((b) => b.name !== workspace.branch).concat({
        name: workspace.branch,
        remote: false,
      }),
      commits: MOCK_COMMITS,
    };
  }

  async activateWorkspace(repo: string, name: string): Promise<void> {
    const workspace = this.find(repo, name);
    workspace.active = true;
    this.emit({ type: "workspace.activated", at: new Date().toISOString(), workspace: { ...workspace } });
  }

  async deactivateWorkspace(repo: string, name: string): Promise<void> {
    const workspace = this.find(repo, name);
    workspace.active = false;
    workspace.agent = null;
    this.emit({ type: "workspace.deactivated", at: new Date().toISOString(), workspace: { ...workspace } });
  }

  async switchBranch(repo: string, name: string, branch: string): Promise<void> {
    const workspace = this.find(repo, name);
    workspace.branch = branch;
    this.emit({ type: "workspace.branch_changed", at: new Date().toISOString(), workspace: { ...workspace } });
  }

  async deleteWorkspace(repo: string, name: string): Promise<void> {
    const i = this.workspaces.findIndex((w) => w.repoName === repo && w.name === name);
    if (i === -1) throw new Error(`workspace not found: ${key(repo, name)}`);
    const workspace = this.workspaces[i]!;
    this.workspaces.splice(i, 1);
    this.emit({ type: "workspace.removed", at: new Date().toISOString(), workspace: { ...workspace } });
  }

  async getArmory(): Promise<ArmoryManifest> {
    return {
      revision: ARMORY_REVISION,
      entries: this.armory
        .map((f) => ({ path: f.path, section: f.section, size: f.size, sha256: f.sha256, mode: f.mode }))
        // Codepoint order, matching how the bridge's scanner sorts a manifest.
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      dotfileMap: { ...SEED_DOTFILE_MAP },
    };
  }

  async getArmoryFile(path: string): Promise<ArmoryFile> {
    const file = this.armory.find((f) => f.path === path);
    if (!file) throw new Error(`armory file not found: ${path}`);
    return { ...file };
  }

  async listArmoryShips(): Promise<ArmoryShipState[]> {
    return this.ships.map((s) => ({
      ship: s.name,
      status: s.status,
      state: SEED_ARMORY_SHIP_STATES[s.name] ?? null,
    }));
  }
}
