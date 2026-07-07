/**
 * fleet-manager.ts — the framework-free core of the bridge.
 *
 * Owns every `ShipConnection`, the fleet-wide `<repo>/<name>` → ship ownership
 * index, duplicate enforcement, mutation routing, and roster persistence. It is
 * deliberately free of any HTTP/Elysia concern so its dedupe and event-mutation
 * logic can be unit-tested against fake connections.
 *
 * State model: each `ShipConnection` holds its own last-known `WorkspaceSummary`
 * map (replaced wholesale on every `sync`); the manager derives a global
 * `index: <repo>/<name> → shipName` from those maps and consults it for O(1)
 * routing and duplicate detection.
 */

import { basename } from "node:path";
import type { FleetEvent, WorkspaceStatus, WorkspaceSummary } from "fleet-protocol";
import { ShipConnection, toWsUrl, type ShipConnectionDeps } from "./ship-connection";
import { loadStore, saveStore, type ShipRecord } from "./store";
import type { BridgeConfig } from "./config";
import {
  workspaceKey,
  type BridgeWorkspaceStatus,
  type BridgeWorkspaceSummary,
  type ShipInfo,
} from "./types";

/** A typed error carrying the HTTP status the API layer should map it to. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** How long to wait for a ship's first `sync` before treating it as offline. */
const SYNC_TIMEOUT_MS = 5000;

/** Derive the repo id (directory name) from a clone URL's basename, minus `.git`. */
function repoBasename(repoUrlOrName: string): string {
  const base = basename(repoUrlOrName);
  return base.endsWith(".git") ? base.slice(0, -".git".length) : base;
}

/** Body of `POST /workspaces` on the bridge (ship-targeted). */
export interface CreateWorkspaceInput {
  readonly repo: string;
  readonly name: string;
  readonly branch: string;
  readonly ship: string;
}

/** An Eden Treaty call result. */
type EdenResult<T> = { data: T | null; error: unknown };

export class FleetManager {
  /** Fleet members, keyed by discovered ship name. */
  private readonly connections = new Map<string, ShipConnection>();
  /** Fleet-wide ownership: `<repo>/<name>` → owning ship name. */
  private readonly index = new Map<string, string>();
  private readonly deps?: Partial<ShipConnectionDeps>;

  constructor(
    private readonly config: BridgeConfig,
    deps?: Partial<ShipConnectionDeps>,
  ) {
    this.deps = deps;
  }

  /**
   * Load the persisted roster, connect to every ship, and enforce the no-duplicate
   * rule across reachable ships. Throws (so the CLI can exit) if two reachable ships
   * hold the same `<repo>/<name>`. Unreachable ships start offline and reconnect in
   * the background.
   */
  async init(): Promise<void> {
    const records = await loadStore(this.config.dataDirectory);
    for (const record of records) {
      const conn = this.createConnection(record.url, record.name);
      conn.member = true;
      this.connections.set(record.name, conn);
      conn.connect();
    }

    // Wait for reachable ships to send their first sync (or time out → offline).
    await Promise.all(
      [...this.connections.values()].map((conn) =>
        conn.waitForSync(SYNC_TIMEOUT_MS).then(
          () => undefined,
          () => undefined,
        ),
      ),
    );

    // Fatal duplicate check across reachable ships, read from the source of truth
    // (each connection's own workspace map) rather than the derived index.
    const duplicates = this.findDuplicates();
    if (duplicates.size > 0) {
      const detail = [...duplicates.entries()]
        .map(([key, ships]) => `  ${key} on ${ships.join(", ")}`)
        .join("\n");
      throw new Error(`duplicate workspaces across ships:\n${detail}`);
    }

    this.rebuildIndex();
  }

  /** Tear down every ship connection (used on shutdown / in tests). */
  shutdown(): void {
    for (const conn of this.connections.values()) conn.close();
  }

  // --- ship management ------------------------------------------------------

  /** `GET /ships`. */
  listShips(): ShipInfo[] {
    return [...this.connections.values()].map((conn) => ({
      name: conn.name,
      url: conn.url,
      status: conn.status,
    }));
  }

  /**
   * `POST /ships`. Connect to a ship by URL, learn its name and workspaces from
   * its first `sync`, reject if the name is already registered or any of its
   * workspaces collide fleet-wide, then adopt and persist it.
   */
  async addShip(url: string): Promise<ShipInfo> {
    const probe = this.createConnection(url);
    probe.connect();

    let name: string;
    try {
      const sync = await probe.waitForSync(SYNC_TIMEOUT_MS);
      name = sync.ship;
    } catch (err) {
      probe.close();
      throw new BridgeError(`ship at ${url} did not respond: ${(err as Error).message}`, 502);
    }

    if (this.connections.has(name)) {
      probe.close();
      throw new BridgeError(`ship already registered: ${name}`, 409);
    }

    const conflicts = [...probe.workspaces.keys()].filter((key) => this.index.has(key));
    if (conflicts.length > 0) {
      probe.close();
      throw new BridgeError(
        `ship "${name}" has workspaces already hosted elsewhere: ${conflicts.join(", ")}`,
        409,
      );
    }

    probe.member = true;
    this.connections.set(name, probe);
    for (const key of probe.workspaces.keys()) this.claim(key, name);
    await this.persist();

    return { name, url, status: probe.status };
  }

  /** `DELETE /ships/:name`. */
  async removeShip(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new BridgeError(`ship not found: ${name}`, 404);

    conn.close();
    this.connections.delete(name);
    for (const [key, owner] of this.index) {
      if (owner === name) this.index.delete(key);
    }
    await this.persist();
  }

  // --- workspace API (superset of the ship's) -------------------------------

  /** `GET /workspaces` — merged, deduped, annotated with the owning ship. */
  listWorkspaces(filter?: "active" | "inactive"): BridgeWorkspaceSummary[] {
    const rows: BridgeWorkspaceSummary[] = [];
    for (const [key, shipName] of this.index) {
      const summary = this.connections.get(shipName)?.workspaces.get(key);
      if (!summary) continue;
      if (filter === "active" && !summary.active) continue;
      if (filter === "inactive" && summary.active) continue;
      rows.push({ ...summary, ship: shipName });
    }
    return rows;
  }

  /** `GET /workspaces/:repo/:name` — proxied live to the owning ship for fresh diff. */
  async getWorkspace(repo: string, name: string): Promise<BridgeWorkspaceStatus> {
    const conn = this.routeFor(repo, name);
    const status = await this.call<WorkspaceStatus>(conn, () =>
      conn.client.workspaces({ repo })({ name }).get() as Promise<EdenResult<WorkspaceStatus>>,
    );
    return { ...status, ship: conn.name };
  }

  /** `POST /workspaces {repo,name,branch,ship}`. */
  async createWorkspace(input: CreateWorkspaceInput): Promise<BridgeWorkspaceSummary> {
    const conn = this.connections.get(input.ship);
    if (!conn) throw new BridgeError(`unknown ship: ${input.ship}`, 400);
    if (conn.status !== "online") throw new BridgeError(`ship "${input.ship}" is offline`, 503);

    const key = workspaceKey(repoBasename(input.repo), input.name);
    if (this.index.has(key)) {
      throw new BridgeError(`workspace already exists: ${key}`, 409);
    }

    const summary = await this.call<WorkspaceSummary>(conn, () =>
      conn.client.workspaces.post({
        repo: input.repo,
        name: input.name,
        branch: input.branch,
      }) as Promise<EdenResult<WorkspaceSummary>>,
    );

    // Optimistic insert so a GET right after create doesn't race the /events WS;
    // the eventual `workspace.created` event overwrites with identical data.
    const createdKey = workspaceKey(summary.repo, summary.name);
    conn.workspaces.set(createdKey, summary);
    this.claim(createdKey, conn.name);

    return { ...summary, ship: conn.name };
  }

  /** `POST /workspaces/:repo/:name/branch`. */
  async switchBranch(repo: string, name: string, branch: string): Promise<void> {
    const conn = this.routeFor(repo, name);
    await this.call(conn, () =>
      conn.client.workspaces({ repo })({ name }).branch.post({ branch }) as Promise<EdenResult<unknown>>,
    );
  }

  /** `POST /workspaces/:repo/:name/activate`. */
  async activate(repo: string, name: string): Promise<void> {
    const conn = this.routeFor(repo, name);
    await this.call(conn, () =>
      conn.client.workspaces({ repo })({ name }).activate.post() as Promise<EdenResult<unknown>>,
    );
  }

  /** `POST /workspaces/:repo/:name/deactivate`. */
  async deactivate(repo: string, name: string): Promise<void> {
    const conn = this.routeFor(repo, name);
    await this.call(conn, () =>
      conn.client.workspaces({ repo })({ name }).deactivate.post() as Promise<EdenResult<unknown>>,
    );
  }

  /** `DELETE /workspaces/:repo/:name`. */
  async remove(repo: string, name: string): Promise<void> {
    const conn = this.routeFor(repo, name);
    await this.call(conn, () =>
      conn.client.workspaces({ repo })({ name }).delete() as Promise<EdenResult<unknown>>,
    );
  }

  /** Resolve the ws:// terminal endpoint on the ship that owns `(repo, name)`. */
  terminalTarget(repo: string, name: string): string {
    const conn = this.routeFor(repo, name);
    return toWsUrl(conn.url, `/workspaces/${repo}/${name}/terminal`);
  }

  // --- internals ------------------------------------------------------------

  private createConnection(url: string, name?: string): ShipConnection {
    const conn = new ShipConnection({ url, name, deps: this.deps });
    conn.setHandlers({
      onEvent: (c, event) => this.onEvent(c, event),
      onStatusChange: () => {},
    });
    return conn;
  }

  /** Apply an event to the ownership index — only for adopted (member) connections. */
  private onEvent(conn: ShipConnection, event: FleetEvent): void {
    if (!conn.member) return;
    this.applyToIndex(conn, event);
  }

  private applyToIndex(conn: ShipConnection, event: FleetEvent): void {
    const shipName = conn.name;
    switch (event.type) {
      case "sync": {
        // Full replace of this ship's contribution: drop stale keys, (re)claim present.
        for (const [key, owner] of this.index) {
          if (owner === shipName && !conn.workspaces.has(key)) this.index.delete(key);
        }
        for (const key of conn.workspaces.keys()) this.claim(key, shipName);
        break;
      }
      case "workspace.removed": {
        const key = workspaceKey(event.workspace.repo, event.workspace.name);
        if (this.index.get(key) === shipName) this.index.delete(key);
        break;
      }
      default: {
        const key = workspaceKey(event.workspace.repo, event.workspace.name);
        this.claim(key, shipName);
      }
    }
  }

  /** Claim ownership of a key for a ship — first-writer-wins on a runtime collision. */
  private claim(key: string, shipName: string): void {
    const owner = this.index.get(key);
    if (owner === undefined) {
      this.index.set(key, shipName);
    } else if (owner !== shipName) {
      console.warn(
        `fleet-bridge: duplicate workspace "${key}" reported by ship "${shipName}"; ` +
          `already owned by "${owner}" — ignoring the newcomer`,
      );
    }
  }

  /** Keys hosted by more than one *online* ship (used for the startup fatal check). */
  private findDuplicates(): Map<string, string[]> {
    const byKey = new Map<string, string[]>();
    for (const conn of this.connections.values()) {
      if (conn.status !== "online") continue;
      for (const key of conn.workspaces.keys()) {
        const ships = byKey.get(key) ?? [];
        ships.push(conn.name);
        byKey.set(key, ships);
      }
    }
    const duplicates = new Map<string, string[]>();
    for (const [key, ships] of byKey) {
      if (ships.length > 1) duplicates.set(key, ships);
    }
    return duplicates;
  }

  /** Rebuild the ownership index from every online connection's workspace map. */
  private rebuildIndex(): void {
    this.index.clear();
    for (const conn of this.connections.values()) {
      if (conn.status !== "online") continue;
      for (const key of conn.workspaces.keys()) this.claim(key, conn.name);
    }
  }

  private routeFor(repo: string, name: string): ShipConnection {
    const key = workspaceKey(repo, name);
    const shipName = this.index.get(key);
    if (!shipName) throw new BridgeError(`workspace not found: ${key}`, 404);
    const conn = this.connections.get(shipName);
    if (!conn || conn.status !== "online") {
      throw new BridgeError(`ship "${shipName}" hosting ${key} is offline`, 503);
    }
    return conn;
  }

  /**
   * Run an Eden call: unwrap `{data,error}`, map a ship-side error to a
   * `BridgeError`, and flip the ship offline on a network-level failure.
   */
  private async call<T>(conn: ShipConnection, fn: () => Promise<EdenResult<T>>): Promise<T> {
    let result: EdenResult<T>;
    try {
      result = await fn();
    } catch (err) {
      conn.markOffline();
      throw new BridgeError(`ship "${conn.name}" unreachable: ${(err as Error).message}`, 503);
    }

    if (result.error) {
      const error = result.error as { status?: number; value?: unknown };
      const status = typeof error.status === "number" ? error.status : 500;
      const value = error.value;
      const message =
        value && typeof value === "object" && "error" in value && typeof value.error === "string"
          ? value.error
          : typeof value === "string"
            ? value
            : JSON.stringify(value);
      throw new BridgeError(message, status);
    }

    if (result.data === null) {
      throw new BridgeError(`ship "${conn.name}" returned no data`, 502);
    }
    return result.data;
  }

  private async persist(): Promise<void> {
    const ships: ShipRecord[] = [...this.connections.values()].map((conn) => ({
      name: conn.name,
      url: conn.url,
    }));
    await saveStore(this.config.dataDirectory, ships);
  }
}
