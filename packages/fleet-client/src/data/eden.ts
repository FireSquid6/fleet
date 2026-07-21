import type { SystemResources } from "fleet-protocol";
import { makeBridgeClient, type BridgeClient } from "./client";
import type { FleetBridge } from "./provider";
import type { Repo, Ship, Workspace, WorkspaceDetail } from "./types";

/** Turn an Eden `{ error }` value into a thrown Error. */
function edenError(error: { status?: unknown; value?: unknown }): Error {
  const detail = error.value === undefined ? error : error.value;
  return new Error(`fleet-bridge request failed: ${JSON.stringify(detail)}`);
}

/** Human-facing hardware blurb from a ship's system resources. */
function deriveSpec(r: SystemResources | null): string {
  if (!r) return "offline";
  const gb = Math.round(r.memory.total / 1e9);
  return `${r.cpu.cores} cores · ${gb} GB · ${r.os.arch}`;
}

/**
 * Real {@link FleetBridge} backed by an Eden treaty against the fleet bridge.
 * The live terminal is a WebSocket stream, handled separately by the Terminal
 * component (see `useWebterm`), not through this request/response surface.
 */
export class EdenFleetBridge implements FleetBridge {
  constructor(private readonly client: BridgeClient = makeBridgeClient()) {}

  async listShips(): Promise<Ship[]> {
    // The ship roster + spec come from the aggregate resources endpoint, which
    // lists every ship (online with resources, offline with null).
    const { data, error } = await this.client["system-resources"].get();
    if (error) throw edenError(error);
    return data.map((s) => ({ name: s.ship, spec: deriveSpec(s.resources), status: s.status }));
  }

  async listRepos(): Promise<Repo[]> {
    const { data, error } = await this.client.repos.get();
    if (error) throw edenError(error);
    // The handler can also surface an in-band `{ error }` body on a 200.
    if (!Array.isArray(data)) throw edenError({ value: data });
    return data;
  }

  async createRepo(input: { name: string; url: string; provider?: string }): Promise<Repo> {
    const { data, error } = await this.client.repos.post(input);
    if (error) throw edenError(error);
    // The handler surfaces an in-band `{ error }` body on a mapped failure.
    if (!data || "error" in data) throw edenError({ value: data });
    return data;
  }

  async deleteRepo(name: string): Promise<void> {
    const { error } = await this.client.repos({ name }).delete();
    if (error) throw edenError(error);
  }

  async createShip(url: string): Promise<Ship> {
    const { data, error } = await this.client.ships.post({ url });
    if (error) throw edenError(error);
    if (!data || "error" in data) throw edenError({ value: data });
    // The bridge returns { name, url, status }; the ship's spec is only known
    // once its system resources are fetched, so leave it blank until refresh.
    return { name: data.name, spec: "", status: data.status };
  }

  async deleteShip(name: string): Promise<void> {
    const { error } = await this.client.ships({ name }).delete();
    if (error) throw edenError(error);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const { data, error } = await this.client.workspaces.get();
    if (error) throw edenError(error);
    // The handler can also surface an in-band `{ error }` body on a 200.
    if (!Array.isArray(data)) throw edenError({ value: data });
    return data;
  }

  async createWorkspace(input: {
    ship: string;
    repoName: string;
    name: string;
    branch: string;
  }): Promise<Workspace> {
    const { data, error } = await this.client.workspaces.post(input);
    if (error) throw edenError(error);
    if (!data || "error" in data) throw edenError({ value: data });
    return data;
  }

  async getWorkspace(repo: string, name: string): Promise<WorkspaceDetail> {
    const { data, error } = await this.client.workspaces({ repo })({ name }).get();
    if (error) throw edenError(error);
    if ("error" in data) throw edenError({ value: data.error });
    return data;
  }

  async getWorkspaceDiff(repo: string, name: string): Promise<string> {
    // `HEAD` captures all staged+unstaged changes vs the last commit; the ship
    // synthesizes add-file diffs for untracked files so brand-new files appear.
    const { data, error } = await this.client
      .workspaces({ repo })({ name })
      .diff.get({ query: { range: "HEAD", includeUntracked: true } });
    if (error) throw edenError(error);
    if (typeof data !== "string") throw edenError({ value: data });
    return data;
  }

  async activateWorkspace(repo: string, name: string): Promise<void> {
    const { error } = await this.client.workspaces({ repo })({ name }).activate.post();
    if (error) throw edenError(error);
  }

  async deactivateWorkspace(repo: string, name: string): Promise<void> {
    const { error } = await this.client.workspaces({ repo })({ name }).deactivate.post();
    if (error) throw edenError(error);
  }
}
