/** The bridge's serialized, atomic JSON-file persistence. */

import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FleetIdentifierSchema, RepoSchema, ShipSchema, type Repo, type Ship } from "fleet-protocol";
import { SessionRecordSchema, UserRecordSchema, type SessionRecord, type UserRecord } from "./auth-records";

type Persist = (target: string, contents: string) => Promise<void>;

export class RepoAlreadyExistsError extends Error {
  constructor(readonly repoName: string) {
    super(`repo already registered: ${repoName}`);
    this.name = "RepoAlreadyExistsError";
  }
}

export class UserAlreadyExistsError extends Error {
  constructor(readonly username: string) {
    super(`user already registered: ${username}`);
    this.name = "UserAlreadyExistsError";
  }
}

export class Store {
  private ships = new Map<string, Ship>();
  private repos = new Map<string, Repo>();
  /** Local accounts, keyed by username. */
  private users = new Map<string, UserRecord>();
  /** Active sessions, keyed by opaque token. */
  private sessions = new Map<string, SessionRecord>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly persist: Persist;

  constructor(
    private readonly dataDirectory: string,
    deps?: { persist?: Persist },
  ) {
    this.persist = deps?.persist ?? atomicWrite;
  }

  private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async load(): Promise<void> {
    return this.serialized(async () => {
      if (this.loaded) return;
      const ships = ShipSchema.array().parse(await this.readFile<unknown>("ships.json"));
      const repos = RepoSchema.array().parse(await this.readFile<unknown>("repos.json"));
      const users = UserRecordSchema.array().parse(await this.readFile<unknown>("users.json"));
      const sessions = SessionRecordSchema.array().parse(await this.readFile<unknown>("sessions.json"));
      this.ships = new Map(ships.map((ship) => [ship.name, ship]));
      this.repos = new Map(repos.map((repo) => [repo.name, repo]));
      this.users = new Map(users.map((user) => [user.username, user]));
      this.sessions = new Map(sessions.map((session) => [session.token, session]));
      this.loaded = true;
    });
  }

  private async readFile<T>(name: string): Promise<T[]> {
    const target = join(this.dataDirectory, name);
    try {
      const info = await lstat(target);
      if (!info.isFile()) throw new Error(`refusing to read non-file store path: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return (await Bun.file(target).json()) as T[];
  }

  private persistShips(ships: Map<string, Ship>): Promise<void> {
    return this.persist(join(this.dataDirectory, "ships.json"), stringify([...ships.values()]));
  }

  private persistRepos(repos: Map<string, Repo>): Promise<void> {
    return this.persist(join(this.dataDirectory, "repos.json"), stringify([...repos.values()]));
  }

  private persistUsers(users: Map<string, UserRecord>): Promise<void> {
    return this.persist(join(this.dataDirectory, "users.json"), stringify([...users.values()]));
  }

  private persistSessions(sessions: Map<string, SessionRecord>): Promise<void> {
    return this.persist(join(this.dataDirectory, "sessions.json"), stringify([...sessions.values()]));
  }

  async getAllShips(): Promise<Ship[]> {
    return this.serialized(() => [...this.ships.values()]);
  }

  async getShip(name: string): Promise<Ship | undefined> {
    return this.serialized(() => this.ships.get(name));
  }

  async createShip(ship: Ship): Promise<Ship> {
    ship = ShipSchema.parse(ship);
    return this.serialized(async () => {
      const ships = new Map(this.ships).set(ship.name, ship);
      await this.persistShips(ships);
      this.ships = ships;
      return ship;
    });
  }

  async upsertShip(ship: Ship): Promise<Ship> {
    return this.createShip(ship);
  }

  async updateShip(name: string, values: Partial<Omit<Ship, "name">>): Promise<Ship | undefined> {
    FleetIdentifierSchema.parse(name);
    return this.serialized(async () => {
      const existing = this.ships.get(name);
      if (!existing) return undefined;
      const updated = ShipSchema.parse({ ...existing, ...values, name });
      const ships = new Map(this.ships).set(name, updated);
      await this.persistShips(ships);
      this.ships = ships;
      return updated;
    });
  }

  async deleteShip(name: string): Promise<Ship | undefined> {
    FleetIdentifierSchema.parse(name);
    return this.serialized(async () => {
      const existing = this.ships.get(name);
      if (!existing) return undefined;
      const ships = new Map(this.ships);
      ships.delete(name);
      await this.persistShips(ships);
      this.ships = ships;
      return existing;
    });
  }

  async replaceAllShips(ships: Ship[]): Promise<void> {
    ships = ShipSchema.array().parse(ships);
    return this.serialized(async () => {
      const replacement = new Map(ships.map((ship) => [ship.name, ship]));
      await this.persistShips(replacement);
      this.ships = replacement;
    });
  }

  async getAllRepos(): Promise<Repo[]> {
    return this.serialized(() => [...this.repos.values()]);
  }

  async getRepo(name: string): Promise<Repo | undefined> {
    return this.serialized(() => this.repos.get(name));
  }

  async createRepo(repo: Repo): Promise<Repo> {
    repo = RepoSchema.parse(repo);
    return this.serialized(async () => {
      if (this.repos.has(repo.name)) throw new RepoAlreadyExistsError(repo.name);
      const repos = new Map(this.repos).set(repo.name, repo);
      await this.persistRepos(repos);
      this.repos = repos;
      return repo;
    });
  }

  async upsertRepo(repo: Repo): Promise<Repo> {
    repo = RepoSchema.parse(repo);
    return this.serialized(async () => {
      const repos = new Map(this.repos).set(repo.name, repo);
      await this.persistRepos(repos);
      this.repos = repos;
      return repo;
    });
  }

  async updateRepo(name: string, values: Partial<Omit<Repo, "name">>): Promise<Repo | undefined> {
    FleetIdentifierSchema.parse(name);
    return this.serialized(async () => {
      const existing = this.repos.get(name);
      if (!existing) return undefined;
      const updated = RepoSchema.parse({ ...existing, ...values, name });
      const repos = new Map(this.repos).set(name, updated);
      await this.persistRepos(repos);
      this.repos = repos;
      return updated;
    });
  }

  async deleteRepo(name: string): Promise<Repo | undefined> {
    FleetIdentifierSchema.parse(name);
    return this.serialized(async () => {
      const existing = this.repos.get(name);
      if (!existing) return undefined;
      const repos = new Map(this.repos);
      repos.delete(name);
      await this.persistRepos(repos);
      this.repos = repos;
      return existing;
    });
  }

  // --- users ----------------------------------------------------------------

  async getUserByUsername(username: string): Promise<UserRecord | undefined> {
    return this.serialized(() => this.users.get(username));
  }

  async getUserById(id: string): Promise<UserRecord | undefined> {
    return this.serialized(() => [...this.users.values()].find((user) => user.id === id));
  }

  async countUsers(): Promise<number> {
    return this.serialized(() => this.users.size);
  }

  async createUser(user: UserRecord): Promise<UserRecord> {
    user = UserRecordSchema.parse(user);
    return this.serialized(async () => {
      if (this.users.has(user.username)) throw new UserAlreadyExistsError(user.username);
      const users = new Map(this.users).set(user.username, user);
      await this.persistUsers(users);
      this.users = users;
      return user;
    });
  }

  // --- sessions -------------------------------------------------------------

  async getSession(token: string): Promise<SessionRecord | undefined> {
    return this.serialized(() => this.sessions.get(token));
  }

  async createSession(session: SessionRecord): Promise<SessionRecord> {
    session = SessionRecordSchema.parse(session);
    return this.serialized(async () => {
      const sessions = new Map(this.sessions).set(session.token, session);
      await this.persistSessions(sessions);
      this.sessions = sessions;
      return session;
    });
  }

  async deleteSession(token: string): Promise<SessionRecord | undefined> {
    return this.serialized(async () => {
      const existing = this.sessions.get(token);
      if (!existing) return undefined;
      const sessions = new Map(this.sessions);
      sessions.delete(token);
      await this.persistSessions(sessions);
      this.sessions = sessions;
      return existing;
    });
  }

  /** Drop every session whose `expiresAt` is at or before `now`. No-op (no write) if none expired. */
  async deleteExpiredSessions(now: number): Promise<void> {
    return this.serialized(async () => {
      const kept = new Map([...this.sessions].filter(([, session]) => session.expiresAt > now));
      if (kept.size === this.sessions.size) return;
      await this.persistSessions(kept);
      this.sessions = kept;
    });
  }
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new Error(`refusing to replace non-file store path: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const stringify = (value: unknown): string => JSON.stringify(value, null, 2);
