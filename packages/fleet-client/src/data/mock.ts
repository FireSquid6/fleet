import type { AgentState, AgentStatus, WorkspaceDiff, WorkspaceRefs } from "fleet-protocol";
import type { DiffQuery } from "@/lib/diff/diff-target";
import type { FleetBridge } from "./provider";
import type { Repo, Ship, Workspace, WorkspaceDetail, WorkspaceEvent } from "./types";

/**
 * In-memory implementation of {@link FleetBridge}. Seed data is ported from the
 * design prototype (`support.js`); the `active` flags are mutable so
 * activate/deactivate persist for the session. The live terminal is not mocked —
 * it streams over a real WebSocket (see the Terminal component's `useWebterm`).
 */

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

/** Deterministic pseudo-pid from a workspace name (matches the prototype hash). */
function hashPid(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return 10000 + (Math.abs(h) % 89999);
}

/** Deterministic mock working-tree diff for an active workspace. */
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

const MOCK_COMMITS: WorkspaceRefs["commits"] = [
  { sha: "9f1c0a2b3d4e5f60718293a4b5c6d7e8f9012345", shortSha: "9f1c0a2", subject: "Add the /version route" },
  { sha: "8e0b9a1c2d3e4f5061728394a5b6c7d8e9f01234", shortSha: "8e0b9a1", subject: "Return structured health output" },
  { sha: "7d9a8b0c1d2e3f4051627384a5b6c7d8e9f01233", shortSha: "7d9a8b0", subject: "Drop the legacy boot entry point" },
  { sha: "6c8970ab1c2d3e4f50617283a4b5c6d7e8f90122", shortSha: "6c8970a", subject: "Wire up the config loader" },
];

/** Seed the repo registry from the distinct repo names in the seed workspaces. */
function seedRepos(): Repo[] {
  const names: string[] = [];
  for (const w of SEED_WORKSPACES) {
    if (!names.includes(w.repoName)) names.push(w.repoName);
  }
  return names.map((name) => ({
    name,
    url: `git@github.com:orchestra/${name}.git`,
    provider: "custom",
  }));
}

export class MockFleetBridge implements FleetBridge {
  private readonly workspaces: Workspace[] = SEED_WORKSPACES.map((w) => ({ ...w }));
  private readonly ships: Ship[] = SHIPS.map((s) => ({ ...s }));
  private readonly repos: Repo[] = seedRepos();
  private readonly workspaceListeners = new Set<(event: WorkspaceEvent) => void>();

  private emit(event: WorkspaceEvent): void {
    for (const listener of this.workspaceListeners) listener(event);
  }

  private find(repo: string, name: string): Workspace {
    const w = this.workspaces.find((x) => x.repoName === repo && x.name === name);
    if (!w) throw new Error(`workspace not found: ${key(repo, name)}`);
    return w;
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
    branch: string;
  }): Promise<Workspace> {
    if (!this.ships.some((s) => s.name === input.ship)) throw new Error(`unknown ship: ${input.ship}`);
    if (!this.repos.some((r) => r.name === input.repoName)) throw new Error(`unknown repo: ${input.repoName}`);
    if (this.workspaces.some((w) => w.repoName === input.repoName && w.name === input.name)) {
      throw new Error(`workspace already exists: ${key(input.repoName, input.name)}`);
    }
    const ws: Workspace = { ...input, active: false, agent: null };
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
}
