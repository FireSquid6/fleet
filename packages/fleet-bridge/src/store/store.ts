/** The bridge's serialized, atomic JSON-file persistence. */

import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FleetIdentifierSchema, RepoSchema, ShipSchema, type Repo, type Ship } from "fleet-protocol";

type Persist = (target: string, contents: string) => Promise<void>;

export class RepoAlreadyExistsError extends Error {
  constructor(readonly repoName: string) {
    super(`repo already registered: ${repoName}`);
    this.name = "RepoAlreadyExistsError";
  }
}

export class Store {
  private ships = new Map<string, Ship>();
  private repos = new Map<string, Repo>();
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
      this.ships = new Map(ships.map((ship) => [ship.name, ship]));
      this.repos = new Map(repos.map((repo) => [repo.name, repo]));
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
