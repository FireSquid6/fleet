import type { Repo, Ship, Workspace, WorkspaceDetail } from "./types";

/**
 * The data our UI needs from the fleet bridge, expressed as one async surface.
 *
 * Every method maps 1:1 to a bridge route. The real implementation would be a
 * thin wrapper over an Eden treaty client:
 *
 *   import { treaty } from "@elysiajs/eden";
 *   import type { App } from "fleet-bridge/api";
 *   const client = treaty<App>(bridgeUrl);
 *   // listWorkspaces() -> client.workspaces.get() -> { data, error }
 *
 * `MockFleetBridge` (see ./mock) implements this against in-memory fixtures so
 * the whole app runs with no bridge attached. Swapping in the Eden-backed
 * implementation is the only change needed to go live.
 */
export interface FleetBridge {
  /** `GET /ships` (joined with `GET /system-resources` for the spec blurb). */
  listShips(): Promise<Ship[]>;
  /** `GET /repos` — the bridge's registered repos. */
  listRepos(): Promise<Repo[]>;
  /** `POST /repos` — register a new repo. */
  createRepo(input: { name: string; url: string; provider?: string }): Promise<Repo>;
  /** `DELETE /repos/:name` — remove a registered repo. */
  deleteRepo(name: string): Promise<void>;
  /** `POST /ships` — register a ship by URL; the bridge discovers its name. */
  createShip(url: string): Promise<Ship>;
  /** `DELETE /ships/:name` — deregister a ship. */
  deleteShip(name: string): Promise<void>;
  /** `GET /workspaces` — every workspace across all ships. */
  listWorkspaces(): Promise<Workspace[]>;
  /** `POST /workspaces` — create a workspace on a given ship for a repo. */
  createWorkspace(input: { ship: string; repoName: string; name: string; branch: string }): Promise<Workspace>;
  /** `GET /workspaces/:repo/:name` — detailed status (diff, ship, …). */
  getWorkspace(repo: string, name: string): Promise<WorkspaceDetail>;
  /** `GET /workspaces/:repo/:name/diff` — raw `git diff` text (incl. untracked). */
  getWorkspaceDiff(repo: string, name: string): Promise<string>;
  /** `POST /workspaces/:repo/:name/activate` — attach a session. */
  activateWorkspace(repo: string, name: string): Promise<void>;
  /** `POST /workspaces/:repo/:name/deactivate` — kill the session. */
  deactivateWorkspace(repo: string, name: string): Promise<void>;
}
