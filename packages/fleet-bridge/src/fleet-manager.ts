import { join } from "node:path";
import {
  ARMORY_DIRECTORY,
  CreateRepoInputSchema,
  FleetIdentifierSchema,
  issueBranchName,
  ShipSchema,
  WorkspaceRefsSchema,
  WorkspaceSummarySchema,
  WorkspaceStatusSchema,
  type ArmoryFile,
  type ArmoryManifest,
  type ArmorySyncState,
  type CreateRepoInput,
  type FleetEvent,
  type Repo,
  type SystemResources,
  type WorkspaceRefs,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "fleet-protocol";
import { Git, GitError, type DiffOptions, type RemoteRef } from "git-bun";
import { TERMINAL_TAKEOVER_QUERY } from "webterm/protocol";
import { bearer, ShipConnection, toWsUrl, type ShipConnectionDeps } from "./ship-connection";
import { defaultPublicUrl, type BridgeConfig } from "./config";
import {
  workspaceKey,
  type BridgeWorkspaceEvent,
  type BridgeWorkspaceStatus,
  type BridgeWorkspaceSummary,
  type RepoBranch,
  type ShipArmoryState,
  type ShipInfo,
  type ShipSystemResources,
} from "./types";
import { RepoAlreadyExistsError, Store } from "./store/store";
import {
  ArmoryMapError,
  ArmoryNotFoundError,
  ArmoryPathError,
  ArmoryService,
  ArmoryTooLargeError,
} from "./armory/armory-service";
import {
  providerFor,
  type CheckRun,
  type FailedJobLog,
  type Issue,
  type IssueComment,
  type IssueSummary,
  type ListOptions,
  type PullRequest,
  type PullRequestSummary,
  type RepoInfo,
  type RepoProvider,
  type Review,
  type ReviewEvent,
} from "./providers";

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

/**
 * Outer bound on a remote ref probe. Deliberately longer than the 15 s of
 * stalled transfer `NON_INTERACTIVE_GIT_ENV` gives git, so that on a dead remote
 * git aborts itself first and the client gets git's own diagnosis instead of a
 * bare "timed out". This is the backstop for a git that somehow does neither.
 */
const LS_REMOTE_TIMEOUT_MS = 20000;

/**
 * Environment for every git invocation the bridge makes. Two failure modes, both
 * of which would otherwise leave a git process alive after the HTTP request that
 * spawned it has gone:
 *
 * - **Prompts.** git asks for credentials, ssh passphrases and unknown host keys
 *   by opening `/dev/tty` directly, bypassing the pipes it was given — and the
 *   bridge normally runs in an operator's foreground terminal, so that tty
 *   exists. A private repo would park git on a prompt nobody answers forever.
 * - **Tarpits.** A remote that completes the TCP handshake and then says nothing
 *   holds git open indefinitely; git only inherits a deadline if it is given
 *   one. The low-speed pair makes git abort a transfer moving under 1 byte/s for
 *   15 s, and `ConnectTimeout` bounds the ssh handshake. Both make git exit on
 *   its own, which is what actually reaps the process — killing the request that
 *   is waiting on it would not.
 *
 * `GIT_HTTP_LOW_SPEED_*` only covers the http(s) transport; an ssh remote that
 * connects and then stalls is still only bounded by `LS_REMOTE_TIMEOUT_MS`.
 */
const NON_INTERACTIVE_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10",
  GIT_HTTP_LOW_SPEED_LIMIT: "1",
  GIT_HTTP_LOW_SPEED_TIME: "15",
};

/**
 * Reject with `message` if `promise` has not settled within `ms`.
 *
 * This bounds the *waiting*, not the work: `git-bun` exposes no handle to abort
 * a running command, so a git process that outlives its deadline is left to exit
 * on its own. That is why `NON_INTERACTIVE_GIT_ENV` configures git to give up by
 * itself — this timer is the backstop, not the mechanism.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A URL-shaped run of text; quotes and whitespace end it, as they do in git's messages. */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi;

/**
 * Blank out `user:secret@` userinfo in every URL a message carries. A repo may
 * be registered with an embedded token, and git echoes the URL it was given back
 * in the command line it reports on failure — this keeps that out of an API
 * response.
 *
 * Parsing beats pattern-matching here: a password may itself contain `@`
 * (`https://user:p@ssw0rd@host/r`), and userinfo runs to the *last* `@` before
 * the path, which a leftmost-shortest regex gets wrong. `URL` implements that
 * rule; the regex below is only for candidates it refuses to parse.
 *
 * Not covered, deliberately: credentials in a query string
 * (`?access_token=…`) and scp-style `token@host:org/repo.git`, neither of which
 * is a URL this code can recognize as one.
 */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_IN_TEXT, (candidate) => {
    try {
      const url = new URL(candidate);
      if (!url.username && !url.password) return candidate;
      url.username = "***";
      url.password = "";
      return url.toString();
    } catch {
      return redactAuthority(candidate);
    }
  });
}

/** Fallback for an unparseable URL: strip through the last `@` of the authority. */
function redactAuthority(candidate: string): string {
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i.exec(candidate);
  if (!parts) return candidate;
  const [, scheme, authority = "", rest = ""] = parts;
  const at = authority.lastIndexOf("@");
  if (at === -1) return candidate;
  return `${scheme}***@${authority.slice(at + 1)}${rest}`;
}

/**
 * Body of `POST /workspaces` on the bridge (ship-targeted, names a registered
 * repo). The branch comes either verbatim from `branch`, or from the issue that
 * `issueNumber` identifies — exactly one of the two, never both.
 */
export interface CreateWorkspaceInput {
  readonly ship: string;
  readonly repoName: string;
  readonly name: string;
  readonly branch?: string;
  readonly issueNumber?: number;
}

/** Which of the two mutually exclusive branch sources a create request chose. */
type BranchSource = { readonly branch: string } | { readonly issueNumber: number };

type EdenResult<T> = { data: T | null; error: unknown };

export interface ShipCredentials {
  readonly shipToken: string;
  readonly bridgeToken: string;
}

export interface ShipCredentialStore {
  bridgeTokenFor(shipName: string): string | undefined;
  setShipCredentials(shipName: string, credentials: ShipCredentials): void;
  deleteShipCredentials(shipName: string): void;
}

export interface TerminalTarget {
  readonly url: string;
  readonly headers?: Record<string, string>;
}

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
  private readonly eventListeners = new Set<(event: BridgeWorkspaceEvent) => void>();
  private readonly deps?: Partial<ShipConnectionDeps>;
  private readonly syncTimeoutMs: number;
  private readonly store: Store;
  private readonly makeProvider: (repo: Repo) => RepoProvider;
  /** Probes a remote's refs; overridable so tests never shell out to git. */
  private readonly lsRemote: typeof Git.lsRemote;
  /** Deadline for one `lsRemote` probe (overridable in tests). */
  private readonly lsRemoteTimeoutMs: number;
  private readonly armory: ArmoryService;
  private readonly credentials?: ShipCredentialStore;

  constructor(
    private readonly config: BridgeConfig,
    deps?: Partial<ShipConnectionDeps>,
    opts?: {
      syncTimeoutMs?: number;
      store?: Store;
      providerFor?: (repo: Repo) => RepoProvider;
      lsRemote?: typeof Git.lsRemote;
      lsRemoteTimeoutMs?: number;
      armory?: ArmoryService;
      credentials?: ShipCredentialStore;
    },
  ) {
    this.deps = deps;
    this.credentials = opts?.credentials;
    this.syncTimeoutMs = opts?.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
    this.store = opts?.store ?? new Store(config.dataDirectory);
    this.makeProvider = opts?.providerFor ?? providerFor;
    this.lsRemote = opts?.lsRemote ?? Git.lsRemote;
    this.lsRemoteTimeoutMs = opts?.lsRemoteTimeoutMs ?? LS_REMOTE_TIMEOUT_MS;
    this.armory = opts?.armory ?? new ArmoryService(join(config.dataDirectory, ARMORY_DIRECTORY));
  }

  /** Throws when two reachable ships hold the same `<repo>/<name>`, so the CLI can exit. */
  async init(): Promise<void> {
    await this.store.load();
    const records = await this.store.getAllShips();
    for (const record of records) {
      const conn = this.createConnection(record.url, record.name, this.credentials?.bridgeTokenFor(record.name));
      conn.member = true;
      this.connections.set(record.name, conn);
      conn.connect();
    }

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

  shutdown(): void {
    for (const conn of this.connections.values()) conn.close();
  }

  subscribe(listener: (event: BridgeWorkspaceEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  workspaceSnapshot(): BridgeWorkspaceSummary[] {
    const workspaces: BridgeWorkspaceSummary[] = [];
    for (const [key, ship] of this.index) {
      const workspace = this.connections.get(ship)?.workspaces.get(key);
      if (workspace) workspaces.push({ ...workspace, ship });
    }
    return workspaces;
  }

  private publish(event: BridgeWorkspaceEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private publishSnapshot(): void {
    this.publish({ type: "sync", at: new Date().toISOString(), workspaces: this.workspaceSnapshot() });
  }

  /** `GET /ships`. */
  listShips(): ShipInfo[] {
    return [...this.connections.values()].map((conn) => ({
      name: conn.name,
      url: conn.url,
      status: conn.status,
    }));
  }

  /** `POST /ships`. */
  async addShip(url: string, credentials?: Partial<ShipCredentials>): Promise<ShipInfo> {
    const pair = this.credentialPair(credentials);
    const probe = this.createConnection(url, undefined, pair?.bridgeToken);
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
    if (pair) this.credentials?.setShipCredentials(name, pair);
    for (const key of probe.workspaces.keys()) this.claim(key, name);
    await this.persist();
    this.publishSnapshot();

    // Fire-and-forget: registering a ship must not fail, or wait, on the armory.
    void this.pushArmoryTo(probe);

    return { name, url, status: probe.status };
  }

  /** `DELETE /ships/:name`. */
  async removeShip(name: string): Promise<void> {
    this.identifier(name, "ship");
    const conn = this.connections.get(name);
    if (!conn) throw new BridgeError(`ship not found: ${name}`, 404);

    conn.close();
    this.connections.delete(name);
    this.credentials?.deleteShipCredentials(name);
    for (const [key, owner] of this.index) {
      if (owner === name) this.releaseOwnership(key, name);
    }
    for (const [key, reservation] of this.createReservations) {
      if (reservation.shipName === name) this.createReservations.delete(key);
    }
    await this.persist();
    this.publishSnapshot();
  }

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

  /** `GET /repos` — the bridge's registered repos. */
  async listRepos(): Promise<Repo[]> {
    return this.store.getAllRepos();
  }

  /** `POST /repos` — register a repo. `provider` defaults to `"custom"`. */
  async addRepo(input: CreateRepoInput): Promise<Repo> {
    const result = CreateRepoInputSchema.safeParse(input);
    if (!result.success) throw new BridgeError("invalid repo", 400);
    const parsed = result.data;
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

  /**
   * `GET /repos/:name/branches` — the branches the repo's remote advertises.
   *
   * Answered with `ls-remote` rather than through the repo's provider on purpose:
   * `addRepo` defaults a repo to `provider: "custom"`, for which `providerFor`
   * throws 501, so a provider-backed listing would be dead for most registered
   * repos. `ls-remote` speaks to any git URL and needs no token.
   */
  async listRepoBranches(name: string): Promise<RepoBranch[]> {
    this.identifier(name, "repo");
    const repo = await this.store.getRepo(name);
    if (!repo) throw new BridgeError(`repo not found: ${name}`, 404);

    let refs: RemoteRef[];
    try {
      refs = await withTimeout(
        this.lsRemote(repo.url, {
          cwd: this.config.dataDirectory,
          heads: true,
          env: NON_INTERACTIVE_GIT_ENV,
        }),
        this.lsRemoteTimeoutMs,
        `timed out after ${this.lsRemoteTimeoutMs}ms`,
      );
    } catch (error) {
      // Any failure here is the remote's or the network's, not the caller's — and
      // a raw GitError must not reach the route, which would report it as a 500.
      // git's own stderr is preferred over the GitError message because the
      // message replays the command line, credentials in the URL included.
      const detail = error instanceof GitError ? error.stderr.trim() || error.message : (error as Error).message;
      throw new BridgeError(
        redactUrlCredentials(`could not list branches for repo "${name}": ${detail}`),
        502,
      );
    }

    const prefix = "refs/heads/";
    return refs
      .filter((ref) => ref.ref.startsWith(prefix))
      .map((ref) => ({ name: ref.ref.slice(prefix.length), sha: ref.sha }))
      // Plain codepoint order, not `localeCompare`: the listing must not reorder
      // itself with the bridge host's locale. `--heads` hides HEAD, so which
      // branch is the default one is not knowable here.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** `ProviderError` from `fn` propagates unchanged so the API can surface its status. */
  private async withProvider<T>(name: string, fn: (provider: RepoProvider) => Promise<T>): Promise<T> {
    this.identifier(name, "repo");
    const repo = await this.store.getRepo(name);
    if (!repo) throw new BridgeError(`repo not found: ${name}`, 404);
    return fn(this.makeProvider(repo));
  }

  /** `GET /repos/:name/info`. */
  async repoInfo(name: string): Promise<RepoInfo> {
    return this.withProvider(name, (provider) => provider.getInfo());
  }

  /** `GET /repos/:name/issues`. */
  async listRepoIssues(name: string, options?: ListOptions): Promise<IssueSummary[]> {
    return this.withProvider(name, (provider) => provider.listIssues(options));
  }

  /** `GET /repos/:name/issues/:number`. */
  async getRepoIssue(name: string, number: number): Promise<Issue> {
    return this.withProvider(name, (provider) => provider.getIssue(number));
  }

  /** `POST /repos/:name/issues/:number/comments`. */
  async commentRepoIssue(name: string, number: number, body: string): Promise<IssueComment> {
    return this.withProvider(name, (provider) => provider.commentOnIssue(number, body));
  }

  /** `GET /repos/:name/pulls`. */
  async listRepoPullRequests(name: string, options?: ListOptions): Promise<PullRequestSummary[]> {
    return this.withProvider(name, (provider) => provider.listPullRequests(options));
  }

  /** `GET /repos/:name/pulls/:number`. */
  async getRepoPullRequest(name: string, number: number): Promise<PullRequest> {
    return this.withProvider(name, (provider) => provider.getPullRequest(number));
  }

  /** `POST /repos/:name/pulls/:number/comments`. */
  async commentRepoPullRequest(name: string, number: number, body: string): Promise<IssueComment> {
    return this.withProvider(name, (provider) => provider.commentOnPullRequest(number, body));
  }

  /** `POST /repos/:name/pulls/:number/reviews`. */
  async reviewRepoPullRequest(
    name: string,
    number: number,
    review: { event: ReviewEvent; body?: string },
  ): Promise<Review> {
    return this.withProvider(name, (provider) => provider.reviewPullRequest(number, review));
  }

  /** `GET /repos/:name/checks` — CI checks for a ref or a PR's head commit. */
  async listRepoChecks(name: string, target: { ref?: string; pr?: number }): Promise<CheckRun[]> {
    return this.withProvider(name, async (provider) => {
      const ref = await this.resolveCheckRef(provider, target);
      return provider.listChecks(ref);
    });
  }

  /** `GET /repos/:name/checks/logs` — raw logs of the failed Actions jobs for a ref or PR. */
  async getRepoFailedLogs(name: string, target: { ref?: string; pr?: number }): Promise<FailedJobLog[]> {
    return this.withProvider(name, async (provider) => {
      const ref = await this.resolveCheckRef(provider, target);
      return provider.getFailedLogs(ref);
    });
  }

  private async resolveCheckRef(
    provider: RepoProvider,
    target: { ref?: string; pr?: number },
  ): Promise<string> {
    if (target.pr !== undefined) {
      const p = await provider.getPullRequest(target.pr);
      return p.headSha;
    }
    if (target.ref !== undefined) return target.ref;
    throw new BridgeError("checks require a ref or pr", 400);
  }

  /** `GET /armory` — the content-addressed manifest of `<dataDirectory>/armory`. */
  async armoryManifest(): Promise<ArmoryManifest> {
    return this.mapArmoryErrors(() => this.armory.manifest());
  }

  /** `GET /armory/file?path=…` — one file the manifest lists. */
  async armoryFile(path: string): Promise<ArmoryFile> {
    return this.mapArmoryErrors(() => this.armory.readFile(path));
  }

  /**
   * `GET /armory/ships` — what each member ship reports having applied. An
   * offline ship, or one whose call fails, reports `state: null` rather than
   * failing the aggregate: one unreachable ship must not blank the page.
   */
  async armoryShipStates(): Promise<ShipArmoryState[]> {
    return Promise.all(
      [...this.connections.values()]
        .filter((conn) => conn.member)
        .map(async (conn) => {
          if (conn.status !== "online") return { ship: conn.name, status: conn.status, state: null };
          try {
            const state = await this.call<ArmorySyncState>(
              conn,
              () => conn.client.armory.get() as Promise<EdenResult<ArmorySyncState>>,
            );
            return { ship: conn.name, status: conn.status, state };
          } catch {
            // `call` flips the connection offline on a network failure, so the
            // status is read back afterwards rather than captured above.
            return { ship: conn.name, status: conn.status, state: null };
          }
        }),
    );
  }

  invalidateArmory(): void {
    this.armory.invalidate();
  }

  /**
   * Never throws and never waits on one ship for another: a push is a
   * notification, not a transaction. Failures are warned about and dropped.
   */
  async pushArmory(): Promise<void> {
    const revision = await this.currentArmoryRevision();
    if (revision === undefined) return;
    const online = [...this.connections.values()].filter(
      (conn) => conn.member && conn.status === "online",
    );
    await Promise.allSettled(online.map((conn) => this.syncArmoryOn(conn, revision)));
  }

  private async pushArmoryTo(conn: ShipConnection): Promise<void> {
    if (!conn.member || conn.status !== "online") return;
    const revision = await this.currentArmoryRevision();
    if (revision === undefined) return;
    // The ship may have dropped while the armory was being scanned.
    if (conn.status !== "online") return;
    await this.syncArmoryOn(conn, revision);
  }

  /** The current revision, or `undefined` when the armory cannot be scanned. */
  private async currentArmoryRevision(): Promise<string | undefined> {
    try {
      return (await this.armoryManifest()).revision;
    } catch (error) {
      console.warn(`fleet-bridge: could not read the armory to push it: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async syncArmoryOn(conn: ShipConnection, revision: string): Promise<void> {
    const bridgeUrl = this.config.publicUrl ?? defaultPublicUrl(this.config.port);
    try {
      await this.call(conn, () =>
        conn.client.armory.sync.post({ bridgeUrl, revision }) as Promise<EdenResult<unknown>>,
      );
    } catch (error) {
      console.warn(
        `fleet-bridge: could not push the armory to ship "${conn.name}": ${(error as Error).message}`,
      );
    }
  }

  private async mapArmoryErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ArmoryPathError || error instanceof ArmoryMapError) {
        throw new BridgeError(error.message, 400);
      }
      if (error instanceof ArmoryNotFoundError) throw new BridgeError(error.message, 404);
      if (error instanceof ArmoryTooLargeError) throw new BridgeError(error.message, 413);
      throw error;
    }
  }

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

  /** `GET /workspaces/:repo/:name/refs` — diffable branches/commits from the owning ship. */
  async getWorkspaceRefs(repo: string, name: string, options: { commits?: number } = {}): Promise<WorkspaceRefs> {
    const conn = this.routeFor(repo, name);
    const response = await this.call<WorkspaceRefs>(conn, () =>
      conn.client.workspaces({ repo })({ name }).refs.get({ query: options }) as Promise<EdenResult<WorkspaceRefs>>,
    );
    const parsed = WorkspaceRefsSchema.safeParse(response);
    if (!parsed.success) throw new BridgeError(`ship "${conn.name}" returned invalid workspace refs`, 502);
    return parsed.data;
  }

  /**
   * `POST /workspaces {ship,repoName,name,branch|issueNumber}` — clones a
   * registered repo onto a branch, either named outright or derived from an
   * issue (which also creates and links that branch on the provider).
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<BridgeWorkspaceSummary> {
    this.identifier(input.repoName, "repo");
    this.identifier(input.name, "workspace");
    const source = this.branchSource(input);
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
      // Resolving the issue happens under the reservation, so two concurrent
      // creates of the same workspace cannot both ask the provider for a branch;
      // the second is turned away with a 409 before it gets here.
      //
      // The branch outliving a failed create is accepted rather than undone: if
      // the ship call below fails, the linked branch stays on the remote with no
      // workspace behind it. Nothing is corrupted — the `finally` still clears
      // the reservation, the error the user sees is the ship's, and a retry
      // resolves the same branch because `linkBranchToIssue` is idempotent.
      const branch =
        "branch" in source ? source.branch : await this.branchForIssue(input.repoName, source.issueNumber);

      const response = await this.call<WorkspaceSummary>(conn, () =>
        conn.client.workspaces.post({
          url: repo.url,
          repoName: input.repoName,
          name: input.name,
          branch,
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

  /**
   * Validate a create request's mutually exclusive branch source. The ship also
   * rejects a blank branch, but doing it here saves the round trip and keeps the
   * "one of the two" rule in a single place.
   */
  private branchSource(input: CreateWorkspaceInput): BranchSource {
    if (input.branch !== undefined && input.issueNumber !== undefined) {
      throw new BridgeError("a workspace is created from a branch or an issue, not both", 400);
    }
    if (input.branch !== undefined) {
      const branch = input.branch.trim();
      if (branch.length === 0) throw new BridgeError("branch must not be empty", 400);
      return { branch };
    }
    if (input.issueNumber !== undefined) {
      // `t.Numeric()` admits 0, 1.5 and -3; rejecting them here costs nothing,
      // where letting them through costs a provider round trip to learn that no
      // such issue exists.
      if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
        throw new BridgeError("issueNumber must be a positive integer", 400);
      }
      return { issueNumber: input.issueNumber };
    }
    throw new BridgeError("a workspace needs either a branch or an issue to start from", 400);
  }

  /**
   * Turn an issue into the branch a new workspace sits on: read the issue, then
   * have the provider create and link `<number>-<slug>`. The name the provider
   * returns wins over the computed one — it may have de-duplicated it.
   */
  private async branchForIssue(repoName: string, issueNumber: number): Promise<string> {
    return this.withProvider(repoName, async (provider) => {
      const issue = await provider.getIssue(issueNumber);
      let computed: string;
      try {
        computed = issueBranchName(issue);
      } catch (error) {
        // The issue identity came from the provider, so a name that cannot be
        // derived from it is an upstream fault, not a bad request.
        throw new BridgeError(
          `could not derive a branch name for issue ${issueNumber}: ${(error as Error).message}`,
          502,
        );
      }
      const linked = await provider.linkBranchToIssue(issueNumber, computed);
      return linked.name;
    });
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

  /**
   * Resolve the ws:// terminal endpoint on the ship that owns `(repo, name)`.
   * With `takeover`, ask the ship to evict whichever connection currently owns
   * the workspace's tmux session.
   */
  terminalTarget(repo: string, name: string, options: { takeover?: boolean } = {}): TerminalTarget {
    const conn = this.routeFor(repo, name);
    const url = new URL(
      toWsUrl(conn.url, `/workspaces/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/terminal`),
    );
    // Added through `searchParams`, not concatenation: a registered ship URL is
    // an unvalidated string, and `toWsUrl` deliberately keeps any query or
    // fragment it carries (`/events` gets them too, so a ship registered with a
    // token keeps it here).
    if (options.takeover) url.searchParams.set(TERMINAL_TAKEOVER_QUERY, "true");
    return {
      url: url.toString(),
      headers: conn.bridgeToken === undefined ? undefined : bearer(conn.bridgeToken),
    };
  }

  private credentialPair(credentials?: Partial<ShipCredentials>): ShipCredentials | undefined {
    const { shipToken, bridgeToken } = credentials ?? {};
    if (shipToken === undefined && bridgeToken === undefined) return undefined;
    if (shipToken === undefined || bridgeToken === undefined) {
      throw new BridgeError("a ship is registered with both a shipToken and a bridgeToken, or neither", 400);
    }
    return { shipToken, bridgeToken };
  }

  private createConnection(url: string, name?: string, bridgeToken?: string): ShipConnection {
    const conn = new ShipConnection({ url, name, bridgeToken, deps: this.deps });
    conn.setHandlers({
      onEvent: (c, event) => this.onEvent(c, event),
      // A ship that restarts or reconnects may have missed pushes, so every
      // arrival at "online" re-syncs it. Fire-and-forget; `pushArmoryTo` warns.
      onStatusChange: (c, status) => {
        if (status === "online") void this.pushArmoryTo(c);
      },
    });
    return conn;
  }

  private onEvent(conn: ShipConnection, event: FleetEvent): void {
    if (!conn.member) return;
    this.applyToIndex(conn, event);
    if (event.type === "sync" || event.type === "workspace.removed") {
      this.publishSnapshot();
      return;
    }

    const key = workspaceKey(event.workspace.repoName, event.workspace.name);
    if (this.index.get(key) !== conn.name) return;
    this.publish({
      type: event.type,
      at: event.at,
      workspace: { ...event.workspace, ship: conn.name },
    });
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

  private async persist(): Promise<void> {
    await this.store.replaceAllShips(
      [...this.connections.values()].map((conn) => ({ name: conn.name, url: conn.url })),
    );
  }
}
