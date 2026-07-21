import type { WorkspaceDiff } from "fleet-protocol";
import type { FleetBridge } from "./provider";
import type { Repo, Ship, Workspace, WorkspaceDetail } from "./types";

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

const SEED_WORKSPACES: Workspace[] = [
  { name: "ws-4f2a", repoName: "api-gateway", ship: "forge-01", branch: "main", active: true },
  { name: "ws-9c11", repoName: "api-gateway", ship: "forge-01", branch: "fix/rate-limit", active: true },
  { name: "ws-2e70", repoName: "api-gateway", ship: "atlas-7", branch: "release/2.3", active: false },
  { name: "ws-6b83", repoName: "auth-svc", ship: "forge-02", branch: "main", active: true },
  { name: "ws-d904", repoName: "auth-svc", ship: "nimbus", branch: "feat/oauth-pkce", active: false },
  { name: "ws-1a5f", repoName: "web-client", ship: "forge-01", branch: "main", active: true },
  { name: "ws-7fc2", repoName: "web-client", ship: "forge-02", branch: "feat/redesign", active: true },
  { name: "ws-3d18", repoName: "web-client", ship: "atlas-7", branch: "hotfix/csp", active: false },
  { name: "ws-8e40", repoName: "billing", ship: "atlas-7", branch: "main", active: true },
  { name: "ws-c227", repoName: "notifier", ship: "nimbus", branch: "main", active: false },
  { name: "ws-5b96", repoName: "data-pipeline", ship: "forge-02", branch: "main", active: true },
  { name: "ws-0a3e", repoName: "data-pipeline", ship: "forge-02", branch: "spike/backfill", active: false },
  { name: "ws-b6d1", repoName: "search-idx", ship: "atlas-7", branch: "main", active: true },
  { name: "ws-e812", repoName: "mobile-bff", ship: "nimbus", branch: "feat/push", active: true },
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
    const ws: Workspace = { ...input, active: false };
    this.workspaces.push(ws);
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
      agent: null,
      issue: null,
      mergeRequest: null,
      ship: w.ship,
    };
  }

  async getWorkspaceDiff(repo: string, name: string): Promise<string> {
    this.find(repo, name);
    return MOCK_DIFF;
  }

  async activateWorkspace(repo: string, name: string): Promise<void> {
    this.find(repo, name).active = true;
  }

  async deactivateWorkspace(repo: string, name: string): Promise<void> {
    this.find(repo, name).active = false;
  }
}
