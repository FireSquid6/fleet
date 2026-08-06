import type { WorkspaceRefs } from "fleet-protocol";
import type { DiffQuery } from "@/lib/diff/diff-target";
import type {
  ArmoryFile,
  ArmoryManifest,
  ArmoryShipState,
  Repo,
  RepoBranch,
  RepoIssue,
  Ship,
  Workspace,
  WorkspaceDetail,
  WorkspaceEvent,
} from "./types";

export interface FleetBridge {
  /** `GET /ships` (joined with `GET /system-resources` for the spec blurb). */
  listShips(): Promise<Ship[]>;
  /** `GET /repos` — the bridge's registered repos. */
  listRepos(): Promise<Repo[]>;
  /** `POST /repos` — register a new repo. */
  createRepo(input: { name: string; url: string; provider?: string }): Promise<Repo>;
  /** `DELETE /repos/:name` — remove a registered repo. */
  deleteRepo(name: string): Promise<void>;
  /** `GET /repos/:name/branches` — the branches the repo's remote advertises. */
  listRepoBranches(name: string): Promise<RepoBranch[]>;
  /** `GET /repos/:name/issues?state=open` — the repo's open issues. */
  listRepoIssues(name: string): Promise<RepoIssue[]>;
  /** `POST /ships` — register a ship by URL; the bridge discovers its name. */
  createShip(url: string, credentials?: { shipToken?: string; bridgeToken?: string }): Promise<Ship>;
  /** `DELETE /ships/:name` — deregister a ship. */
  deleteShip(name: string): Promise<void>;
  /** `GET /workspaces` — every workspace across all ships. */
  listWorkspaces(): Promise<Workspace[]>;
  /** `WS /events` — live workspace snapshots and changes. */
  subscribeWorkspaces(listener: (event: WorkspaceEvent) => void, onError?: (error: Error) => void): () => void;
  /**
   * `POST /workspaces` — create a workspace on a given ship for a repo. The
   * branch is either named outright or derived by the bridge from an issue;
   * exactly one of `branch` and `issueNumber` may be sent.
   */
  createWorkspace(input: {
    ship: string;
    repoName: string;
    name: string;
    branch?: string;
    issueNumber?: number;
    ephemeral?: boolean;
  }): Promise<Workspace>;
  /** `GET /workspaces/:repo/:name` — detailed status (diff, ship, …). */
  getWorkspace(repo: string, name: string): Promise<WorkspaceDetail>;
  /** `GET /workspaces/:repo/:name/diff` — raw `git diff` text for a {@link DiffQuery}. */
  getWorkspaceDiff(repo: string, name: string, query: DiffQuery): Promise<string>;
  /** `GET /workspaces/:repo/:name/refs` — branches and recent commits to diff against. */
  getWorkspaceRefs(repo: string, name: string): Promise<WorkspaceRefs>;
  /** `POST /workspaces/:repo/:name/activate` — attach a session. */
  activateWorkspace(repo: string, name: string): Promise<void>;
  /** `POST /workspaces/:repo/:name/deactivate` — kill the session. */
  deactivateWorkspace(repo: string, name: string): Promise<void>;
  /** `POST /workspaces/:repo/:name/branch` — switch the workspace's git branch. */
  switchBranch(repo: string, name: string, branch: string): Promise<void>;
  /** `DELETE /workspaces/:repo/:name` — remove a workspace. */
  deleteWorkspace(repo: string, name: string): Promise<void>;
  /** `GET /armory` — the bridge's armory manifest. */
  getArmory(): Promise<ArmoryManifest>;
  /** `GET /armory/file?path=` — one armory file's contents. */
  getArmoryFile(path: string): Promise<ArmoryFile>;
  /** `GET /armory/ships` — what each ship has applied. */
  listArmoryShips(): Promise<ArmoryShipState[]>;
}
