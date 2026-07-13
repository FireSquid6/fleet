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
  /** `GET /workspaces` — every workspace across all ships. */
  listWorkspaces(): Promise<Workspace[]>;
  /** `GET /workspaces/:repo/:name` — detailed status (diff, ship, …). */
  getWorkspace(repo: string, name: string): Promise<WorkspaceDetail>;
  /** `POST /workspaces/:repo/:name/activate` — attach a session. */
  activateWorkspace(repo: string, name: string): Promise<void>;
  /** `POST /workspaces/:repo/:name/deactivate` — kill the session. */
  deactivateWorkspace(repo: string, name: string): Promise<void>;
}
