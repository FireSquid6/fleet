import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FleetIdentifierSchema, RepoSchema, ShipSchema, type Repo, type Ship } from "fleet-protocol";
import type { z } from "zod";
import { SerialQueue } from "../serial-queue";

type Persist = (target: string, contents: string) => Promise<void>;

export class RepoAlreadyExistsError extends Error {
  constructor(readonly repoName: string) {
    super(`repo already registered: ${repoName}`);
    this.name = "RepoAlreadyExistsError";
  }
}

class JsonCollection<T extends { name: string }> {
  private map = new Map<string, T>();

  constructor(
    private readonly queue: SerialQueue,
    private readonly schema: z.ZodType<T>,
    private readonly target: string,
    private readonly persist: Persist,
  ) {}

  async read(): Promise<Map<string, T>> {
    const items = this.schema.array().parse(await readJsonArray(this.target));
    return new Map(items.map((item) => [item.name, item]));
  }

  adopt(map: Map<string, T>): void {
    this.map = map;
  }

  getAll(): Promise<T[]> {
    return this.queue.run(() => [...this.map.values()]);
  }

  get(name: string): Promise<T | undefined> {
    return this.queue.run(() => this.map.get(name));
  }

  put(item: T, guard?: (current: ReadonlyMap<string, T>) => void): Promise<T> {
    const parsed = this.schema.parse(item);
    return this.queue.run(async () => {
      guard?.(this.map);
      const next = new Map(this.map).set(parsed.name, parsed);
      await this.write(next);
      this.map = next;
      return parsed;
    });
  }

  update(name: string, values: Partial<Omit<T, "name">>): Promise<T | undefined> {
    FleetIdentifierSchema.parse(name);
    return this.queue.run(async () => {
      const existing = this.map.get(name);
      if (!existing) return undefined;
      const updated = this.schema.parse({ ...existing, ...values, name });
      const next = new Map(this.map).set(name, updated);
      await this.write(next);
      this.map = next;
      return updated;
    });
  }

  delete(name: string): Promise<T | undefined> {
    FleetIdentifierSchema.parse(name);
    return this.queue.run(async () => {
      const existing = this.map.get(name);
      if (!existing) return undefined;
      const next = new Map(this.map);
      next.delete(name);
      await this.write(next);
      this.map = next;
      return existing;
    });
  }

  replaceAll(items: T[]): Promise<void> {
    const parsed = this.schema.array().parse(items);
    return this.queue.run(async () => {
      const next = new Map(parsed.map((item) => [item.name, item]));
      await this.write(next);
      this.map = next;
    });
  }

  private write(map: Map<string, T>): Promise<void> {
    return this.persist(this.target, stringify([...map.values()]));
  }
}

export class Store {
  private loaded = false;
  private readonly queue = new SerialQueue();
  private readonly shipCollection: JsonCollection<Ship>;
  private readonly repoCollection: JsonCollection<Repo>;

  constructor(
    dataDirectory: string,
    deps?: { persist?: Persist },
  ) {
    const persist = deps?.persist ?? atomicWrite;
    this.shipCollection = new JsonCollection(
      this.queue,
      ShipSchema,
      join(dataDirectory, "ships.json"),
      persist,
    );
    this.repoCollection = new JsonCollection(
      this.queue,
      RepoSchema,
      join(dataDirectory, "repos.json"),
      persist,
    );
  }

  async load(): Promise<void> {
    return this.queue.run(async () => {
      if (this.loaded) return;
      const ships = await this.shipCollection.read();
      const repos = await this.repoCollection.read();
      this.shipCollection.adopt(ships);
      this.repoCollection.adopt(repos);
      this.loaded = true;
    });
  }

  async getAllShips(): Promise<Ship[]> {
    return this.shipCollection.getAll();
  }

  async getShip(name: string): Promise<Ship | undefined> {
    return this.shipCollection.get(name);
  }

  async createShip(ship: Ship): Promise<Ship> {
    return this.shipCollection.put(ship);
  }

  async updateShip(name: string, values: Partial<Omit<Ship, "name">>): Promise<Ship | undefined> {
    return this.shipCollection.update(name, values);
  }

  async replaceAllShips(ships: Ship[]): Promise<void> {
    return this.shipCollection.replaceAll(ships);
  }

  async getAllRepos(): Promise<Repo[]> {
    return this.repoCollection.getAll();
  }

  async getRepo(name: string): Promise<Repo | undefined> {
    return this.repoCollection.get(name);
  }

  async createRepo(repo: Repo): Promise<Repo> {
    return this.repoCollection.put(repo, (current) => {
      if (current.has(repo.name)) throw new RepoAlreadyExistsError(repo.name);
    });
  }

  async updateRepo(name: string, values: Partial<Omit<Repo, "name">>): Promise<Repo | undefined> {
    return this.repoCollection.update(name, values);
  }

  async deleteRepo(name: string): Promise<Repo | undefined> {
    return this.repoCollection.delete(name);
  }
}

async function readJsonArray(target: string): Promise<unknown[]> {
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new Error(`refusing to read non-file store path: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return (await Bun.file(target).json()) as unknown[];
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
