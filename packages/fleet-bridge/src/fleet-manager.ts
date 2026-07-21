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

import {
  CreateRepoInputSchema,
  FleetIdentifierSchema,
  ShipSchema,
  WorkspaceSummarySchema,
  WorkspaceStatusSchema,
  type CreateRepoInput,
  type FleetEvent,
  type Repo,
  type SystemResources,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "fleet-protocol";
import type { DiffOptions } from "git-bun";
import { ShipConnection, toWsUrl, type ShipConnectionDeps } from "./ship-connection";
import type { BridgeConfig } from "./config";
import {
  workspaceKey,
  type BridgeWorkspaceStatus,
  type BridgeWorkspaceSummary,
  type ShipInfo,
  type ShipSystemResources,
} from "./types";
import { RepoAlreadyExistsError, Store } from "./store/store";

/** A typed error carrying the HTTP status the API layer should map it to. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly ambiguousOutcome = false,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** How long to wait for a ship's first `sync` before treating it as offline. */
const SYNC_TIMEOUT_MS = 5000;

/** Body of `POST /workspaces` on the bridge (ship-targeted, names a registered repo). */
export interface CreateWorkspaceInput {
  readonly ship: string;
  readonly repoName: string;
  readonly name: string;
  readonly branch: string;
}

type EdenResult<T> = { data: T | null; error: unknown };

interface CreateReservation {
  readonly shipName: string;
  state: "pending" | "indeterminate";
}

export class FleetManager {
  /** Fleet members, keyed by discovered ship name. */
  private readonly connections = new Map<string, ShipConnection>();
  /** Fleet-wide ownership: `<repo>/<name>` → owning ship name. */
  private readonly index = new Map<string, string>();
  /** In-flight and transport-ambiguous creates stay separate from confirmed routing ownership. */
  private readonly createReservations = new Map<string, CreateReservation>();
  private readonly deps?: Partial<ShipConnectionDeps>;
  /** How long to wait for a ship's first `sync` (overridable in tests). */
  private readonly syncTimeoutMs: number;
  /** Ship roster + repo registry persistence. Tests inject a shared `Store` via `opts.store`. */
  private readonly store: Store;

  constructor(
    private readonly config: BridgeConfig,
    deps?: Partial<ShipConnectionDeps>,
    opts?: { syncTimeoutMs?: number; store?: Store },
  ) {
    this.deps = deps;
    this.syncTimeoutMs = opts?.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
    this.store = opts?.store ?? new Store(config.dataDirectory);
  }

  /**
   * Load the persisted roster, connect to every ship, and enforce the no-duplicate
   * rule across reachable ships. Throws (so the CLI can exit) if two reachable ships
   * hold the same `<repo>/<name>`. Unreachable ships start offline and reconnect in
   * the background.
   */
  async init(): Promise<void> {
    await this.store.load();
    const records = await this.store.getAllShips();
    for (const record of records) {
      const conn = this.createConnection(record.url, record.name);
      conn.member = true;
      this.connections.set(record.name, conn);
      conn.connect();
    }

    // Wait for reachable ships to send their first sync (or time out → offline).
    await Promise.all(
      [...this.connections.values()].map((conn) =>
        conn.waitForSync(this.syncTimeoutMs).then(
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
      const sync = await probe.waitForSync(this.syncTimeoutMs);
      const parsed = ShipSchema.safeParse({ name: sync.ship, url });
      if (!parsed.success) throw new Error("invalid ship identity");
      name = parsed.data.name;
    } catch (err) {
      probe.close();
      throw new BridgeError(`ship at ${url} did not respond: ${(err as Error).message}`, 502);
    }

    if (this.connections.has(name)) {
      probe.close();
      throw new BridgeError(`ship already registered: ${name}`, 409);
    }

    const conflicts = [...probe.workspaces.keys()].filter(
      (key) => this.index.has(key) || this.createReservations.has(key),
    );
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
    this.identifier(name, "ship");
    const conn = this.connections.get(name);
    if (!conn) throw new BridgeError(`ship not found: ${name}`, 404);

    conn.close();
    this.connections.delete(name);
    for (const [key, owner] of this.index) {
      if (owner === name) this.releaseOwnership(key, name);
    }
    for (const [key, reservation] of this.createReservations) {
      if (reservation.shipName === name) this.createReservations.delete(key);
    }
    await this.persist();
  }

  // --- system resources -----------------------------------------------------

  /** `GET /ships/:ship/system-resources` — proxied live to one ship. */
  async getShipSystemResources(shipName: string): Promise<SystemResources> {
    const conn = this.connections.get(shipName);
    if (!conn) throw new BridgeError(`unknown ship: ${shipName}`, 400);
    if (conn.status !== "online") throw new BridgeError(`ship "${shipName}" is offline`, 503);
    return this.fetchSystemResources(conn);
  }

  /**
   * `GET /system-resources` — fetch every ship's resources in parallel. Offline
   * ships (and any that error) are reported with `resources: null` rather than
   * failing the whole aggregate.
   */
  async listSystemResources(): Promise<ShipSystemResources[]> {
    return Promise.all(
      [...this.connections.values()].map(async (conn) => {
        if (conn.status !== "online") {
          return { ship: conn.name, status: conn.status, resources: null, error: null };
        }
        try {
          const resources = await this.fetchSystemResources(conn);
          return { ship: conn.name, status: conn.status, resources, error: null };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { ship: conn.name, status: conn.status, resources: null, error };
        }
      }),
    );
  }

  private fetchSystemResources(conn: ShipConnection): Promise<SystemResources> {
    return this.call<SystemResources>(
      conn,
      () => conn.client["system-resources"].get() as Promise<EdenResult<SystemResources>>,
    );
  }

  // --- repos (bridge-owned registry) ----------------------------------------

  /** `GET /repos` — the bridge's registered repos. */
  async listRepos(): Promise<Repo[]> {
    return this.store.getAllRepos();
  }

  /** `POST /repos` — register a repo. `provider` defaults to `"custom"`. */
  async addRepo(input: CreateRepoInput): Promise<Repo> {
    const parsed = this.parseInput(CreateRepoInputSchema, input, "repo");
    try {
      return await this.store.createRepo({
        name: parsed.name,
        url: parsed.url,
        provider: parsed.provider ?? "custom",
      });
    } catch (error) {
      if (error instanceof RepoAlreadyExistsError) {
        throw new BridgeError(`repo already registered: ${parsed.name}`, 409);
      }
      throw error;
    }
  }

  /** `DELETE /repos/:name`. */
  async removeRepo(name: string): Promise<void> {
    this.identifier(name, "repo");
    const deleted = await this.store.deleteRepo(name);
    if (!deleted) throw new BridgeError(`repo not found: ${name}`, 404);
  }

  // --- workspace API (superset of the ship's) -------------------------------

  /** `GET /workspaces` — merged, deduped, annotated with the owning ship. */
  async listWorkspaces(filter?: "active" | "inactive"): Promise<BridgeWorkspaceSummary[]> {
    const snapshots = await Promise.all(
      [...this.connections.values()].map(async (conn) => {
        if (conn.status !== "online") return;
        const workspaces = await this.call<WorkspaceSummary[]>(conn, () =>
          conn.client.workspaces.get() as Promise<EdenResult<WorkspaceSummary[]>>,
        ).catch(() => undefined);
        if (workspaces) return { conn, workspaces };
      }),
    );
    for (const snapshot of snapshots) {
      if (snapshot) this.applyWorkspaceSnapshot(snapshot.conn, snapshot.workspaces);
    }

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
    const response = await this.call<WorkspaceStatus>(conn, () =>
      conn.client.workspaces({ repo })({ name }).get() as Promise<EdenResult<WorkspaceStatus>>,
    );
    const parsed = WorkspaceStatusSchema.safeParse(response);
    if (!parsed.success) throw new BridgeError(`ship "${conn.name}" returned an invalid workspace status`, 502);
    const status = parsed.data;
    if (status.repoName !== repo || status.name !== name) {
      throw new BridgeError(`ship "${conn.name}" returned a workspace identity that was not requested`, 502);
    }
    return { ...status, ship: conn.name };
  }

  /** `GET /workspaces/:repo/:name/diff` — raw `git diff` text from the owning ship. */
  async getWorkspaceDiff(repo: string, name: string, options: DiffOptions): Promise<string> {
    const conn = this.routeFor(repo, name);
    return this.call<string>(conn, () =>
      conn.client.workspaces({ repo })({ name }).diff.get({ query: options }) as Promise<EdenResult<string>>,
    );
  }

  /** `POST /workspaces {ship,repoName,name,branch}` — clones a registered repo. */
  async createWorkspace(input: CreateWorkspaceInput): Promise<BridgeWorkspaceSummary> {
    this.identifier(input.repoName, "repo");
    this.identifier(input.name, "workspace");
    const conn = this.connections.get(input.ship);
    if (!conn) throw new BridgeError(`unknown ship: ${input.ship}`, 400);

    const repo = await this.store.getRepo(input.repoName);
    if (!repo) throw new BridgeError(`unknown repo: ${input.repoName}`, 400);
    if (this.connections.get(input.ship) !== conn) {
      throw new BridgeError(`ship "${input.ship}" was removed while validating the create request`, 409);
    }
    if (conn.status !== "online") throw new BridgeError(`ship "${input.ship}" is offline`, 503);

    const key = workspaceKey(input.repoName, input.name);
    if (this.index.has(key)) {
      throw new BridgeError(`workspace already exists: ${key}`, 409);
    }
    const existingReservation = this.createReservations.get(key);
    if (existingReservation) {
      const detail =
        existingReservation.state === "indeterminate"
          ? `workspace creation outcome is unknown: ${key} on ship "${existingReservation.shipName}"; ` +
            `wait for confirmation or remove that ship to clear the reservation`
          : `workspace creation already in progress: ${key} on ship "${existingReservation.shipName}"`;
      throw new BridgeError(detail, 409);
    }
    const reservation: CreateReservation = { shipName: conn.name, state: "pending" };
    this.createReservations.set(key, reservation);
    let retainReservation = false;

    try {
      const response = await this.call<WorkspaceSummary>(conn, () =>
        conn.client.workspaces.post({
          url: repo.url,
          repoName: input.repoName,
          name: input.name,
          branch: input.branch,
        }) as Promise<EdenResult<WorkspaceSummary>>,
        { ambiguousEmptyResponse: true },
      );
      const parsedSummary = WorkspaceSummarySchema.safeParse(response);
      if (!parsedSummary.success) {
        throw new BridgeError(`ship "${conn.name}" returned an invalid workspace summary`, 502, true);
      }
      const summary = parsedSummary.data;
      if (summary.repoName !== input.repoName || summary.name !== input.name) {
        throw new BridgeError(
          `ship "${conn.name}" returned a workspace identity that was not requested`,
          502,
          true,
        );
      }
      if (this.connections.get(conn.name) !== conn) {
        throw new BridgeError(`ship "${conn.name}" was removed while creating ${key}`, 409);
      }

      // Optimistic insert so a GET right after create doesn't race the /events WS;
      // the eventual `workspace.created` event overwrites with identical data.
      conn.workspaces.set(key, summary);
      this.claim(key, conn.name);

      const confirmedOwner = this.index.get(key);
      if (confirmedOwner !== conn.name) {
        const owner = confirmedOwner ?? "another ship";
        throw new BridgeError(
          `workspace ${key} was confirmed on ship "${owner}" while creation targeted "${conn.name}"`,
          409,
        );
      }

      return { ...summary, ship: conn.name };
    } catch (err) {
      if (
        err instanceof BridgeError &&
        err.ambiguousOutcome &&
        this.index.get(key) !== conn.name
      ) {
        reservation.state = "indeterminate";
        retainReservation = true;
      }
      throw err;
    } finally {
      if (!retainReservation && this.createReservations.get(key) === reservation) {
        this.createReservations.delete(key);
      }
    }
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
    return toWsUrl(
      conn.url,
      `/workspaces/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/terminal`,
    );
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
          if (owner === shipName && !conn.workspaces.has(key)) this.releaseOwnership(key, shipName);
        }
        for (const key of conn.workspaces.keys()) this.claim(key, shipName);
        break;
      }
      case "workspace.removed": {
        const key = workspaceKey(event.workspace.repoName, event.workspace.name);
        conn.workspaces.delete(key);
        this.releaseOwnership(key, shipName);
        break;
      }
      default: {
        const key = workspaceKey(event.workspace.repoName, event.workspace.name);
        this.claim(key, shipName);
      }
    }
  }

  private applyWorkspaceSnapshot(conn: ShipConnection, workspaces: WorkspaceSummary[]): void {
    const parsed = WorkspaceSummarySchema.array().safeParse(workspaces);
    if (!parsed.success) throw new BridgeError(`ship "${conn.name}" returned an invalid workspace snapshot`, 502);
    workspaces = parsed.data;
    const keys = new Set(workspaces.map((workspace) => workspaceKey(workspace.repoName, workspace.name)));
    for (const key of conn.workspaces.keys()) {
      if (keys.has(key)) continue;
      conn.workspaces.delete(key);
      this.releaseOwnership(key, conn.name);
    }
    for (const workspace of workspaces) {
      const key = workspaceKey(workspace.repoName, workspace.name);
      conn.workspaces.set(key, workspace);
      this.claim(key, conn.name);
    }
  }

  /** Claim ownership of a key for a ship — first-writer-wins on a runtime collision. */
  private claim(key: string, shipName: string): void {
    const reservation = this.createReservations.get(key);

    const owner = this.index.get(key);
    if (owner === undefined) {
      this.index.set(key, shipName);
    } else if (owner !== shipName) {
      console.warn(
        `fleet-bridge: duplicate workspace "${key}" reported by ship "${shipName}"; ` +
          `already owned by "${owner}" — ignoring the newcomer`,
      );
    }

    if (reservation?.state === "indeterminate" && reservation.shipName === shipName) {
      this.createReservations.delete(key);
    }
  }

  private releaseOwnership(key: string, shipName: string): void {
    if (this.index.get(key) !== shipName) return;
    const successor = [...this.connections.values()]
      .filter((conn) => conn.name !== shipName && conn.workspaces.has(key))
      .sort(
        (a, b) =>
          Number(b.status === "online") - Number(a.status === "online") || a.name.localeCompare(b.name),
      )[0];
    if (successor) this.index.set(key, successor.name);
    else this.index.delete(key);
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
    this.identifier(repo, "repo");
    this.identifier(name, "workspace");
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
  private async call<T>(
    conn: ShipConnection,
    fn: () => Promise<EdenResult<T>>,
    opts?: { ambiguousEmptyResponse?: boolean },
  ): Promise<T> {
    let request: Promise<EdenResult<T>>;
    try {
      request = fn();
    } catch (err) {
      conn.markOffline();
      throw new BridgeError(`ship "${conn.name}" unreachable: ${(err as Error).message}`, 503);
    }

    let result: EdenResult<T>;
    try {
      result = await request;
    } catch (err) {
      conn.markOffline();
      throw new BridgeError(`ship "${conn.name}" unreachable: ${(err as Error).message}`, 503, true);
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
      throw new BridgeError(`ship "${conn.name}" returned no data`, 502, opts?.ambiguousEmptyResponse);
    }
    return result.data;
  }

  private identifier(value: string, label: string): void {
    if (!FleetIdentifierSchema.safeParse(value).success) {
      throw new BridgeError(`invalid ${label} identifier`, 400);
    }
  }

  private parseInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, label: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new BridgeError(`invalid ${label}`, 400);
    return result.data;
  }

  private async persist(): Promise<void> {
    await this.store.replaceAllShips(
      [...this.connections.values()].map((conn) => ({ name: conn.name, url: conn.url })),
    );
  }
}
