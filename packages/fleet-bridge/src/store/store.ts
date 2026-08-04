import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  EphemeralWorkspaceSchema,
  FleetIdentifierSchema,
  RepoSchema,
  ShipSchema,
  type Repo,
  type Ship,
} from "fleet-protocol";
import type { z } from "zod";
import { SerialQueue } from "../serial-queue";
import { workspaceKey } from "../types";

type Persist = (target: string, contents: string) => Promise<void>;

/** An ephemeral workspace as persisted: its public block plus where it lives. */
export const EphemeralWorkspaceRecordSchema = EphemeralWorkspaceSchema.extend({
  repoName: FleetIdentifierSchema,
  name: FleetIdentifierSchema,
  ship: FleetIdentifierSchema,
});

export type EphemeralWorkspaceRecord = z.infer<typeof EphemeralWorkspaceRecordSchema>;

export class RepoAlreadyExistsError extends Error {
  constructor(readonly repoName: string) {
    super(`repo already registered: ${repoName}`);
    this.name = "RepoAlreadyExistsError";
  }
}

interface Keying<T> {
  /** The map key an item is stored under. */
  readonly of: (item: T) => string;
  /** The fields `of` reads, reapplied after an update so a merge cannot move a record. */
  readonly identity: (item: T) => Partial<T>;
  readonly validate: (key: string) => void;
}

function namedKeying<T extends { name: string }>(): Keying<T> {
  return {
    of: (item) => item.name,
    identity: (item) => ({ name: item.name }) as Partial<T>,
    validate: (key) => {
      FleetIdentifierSchema.parse(key);
    },
  };
}

const ephemeralKeying: Keying<EphemeralWorkspaceRecord> = {
  of: (record) => workspaceKey(record.repoName, record.name),
  identity: (record) => ({ repoName: record.repoName, name: record.name }),
  validate: (key) => {
    const parts = key.split("/");
    if (parts.length !== 2) throw new Error(`not a workspace key: ${key}`);
    for (const part of parts) FleetIdentifierSchema.parse(part);
  },
};

class JsonCollection<T> {
  private map = new Map<string, T>();

  constructor(
    private readonly queue: SerialQueue,
    private readonly schema: z.ZodType<T>,
    private readonly target: string,
    private readonly persist: Persist,
    private readonly key: Keying<T>,
  ) {}

  async read(): Promise<Map<string, T>> {
    const items = this.schema.array().parse(await readJsonArray(this.target));
    return new Map(items.map((item) => [this.key.of(item), item]));
  }

  adopt(map: Map<string, T>): void {
    this.map = map;
  }

  getAll(): Promise<T[]> {
    return this.queue.run(() => [...this.map.values()]);
  }

  get(key: string): Promise<T | undefined> {
    return this.queue.run(() => this.map.get(key));
  }

  put(item: T, guard?: (current: ReadonlyMap<string, T>) => void): Promise<T> {
    const parsed = this.schema.parse(item);
    return this.queue.run(async () => {
      guard?.(this.map);
      const next = new Map(this.map).set(this.key.of(parsed), parsed);
      await this.write(next);
      this.map = next;
      return parsed;
    });
  }

  update(key: string, values: Partial<T>): Promise<T | undefined> {
    this.key.validate(key);
    return this.queue.run(async () => {
      const existing = this.map.get(key);
      if (!existing) return undefined;
      const updated = this.schema.parse({ ...existing, ...values, ...this.key.identity(existing) });
      const next = new Map(this.map).set(key, updated);
      await this.write(next);
      this.map = next;
      return updated;
    });
  }

  delete(key: string): Promise<T | undefined> {
    this.key.validate(key);
    return this.queue.run(async () => {
      const existing = this.map.get(key);
      if (!existing) return undefined;
      const next = new Map(this.map);
      next.delete(key);
      await this.write(next);
      this.map = next;
      return existing;
    });
  }

  replaceAll(items: T[]): Promise<void> {
    const parsed = this.schema.array().parse(items);
    return this.queue.run(async () => {
      const next = new Map(parsed.map((item) => [this.key.of(item), item]));
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
  private readonly ephemeralCollection: JsonCollection<EphemeralWorkspaceRecord>;

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
      namedKeying(),
    );
    this.repoCollection = new JsonCollection(
      this.queue,
      RepoSchema,
      join(dataDirectory, "repos.json"),
      persist,
      namedKeying(),
    );
    this.ephemeralCollection = new JsonCollection(
      this.queue,
      EphemeralWorkspaceRecordSchema,
      join(dataDirectory, "ephemeral.json"),
      persist,
      ephemeralKeying,
    );
  }

  async load(): Promise<void> {
    return this.queue.run(async () => {
      if (this.loaded) return;
      const ships = await this.shipCollection.read();
      const repos = await this.repoCollection.read();
      const ephemeral = await this.ephemeralCollection.read();
      this.shipCollection.adopt(ships);
      this.repoCollection.adopt(repos);
      this.ephemeralCollection.adopt(ephemeral);
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

  async getAllEphemeral(): Promise<EphemeralWorkspaceRecord[]> {
    return this.ephemeralCollection.getAll();
  }

  async getEphemeral(repoName: string, name: string): Promise<EphemeralWorkspaceRecord | undefined> {
    return this.ephemeralCollection.get(ephemeralKey(repoName, name));
  }

  async createEphemeral(record: EphemeralWorkspaceRecord): Promise<EphemeralWorkspaceRecord> {
    return this.ephemeralCollection.put(record);
  }

  async updateEphemeral(
    repoName: string,
    name: string,
    values: Partial<EphemeralWorkspaceRecord>,
  ): Promise<EphemeralWorkspaceRecord | undefined> {
    return this.ephemeralCollection.update(ephemeralKey(repoName, name), values);
  }

  async deleteEphemeral(repoName: string, name: string): Promise<EphemeralWorkspaceRecord | undefined> {
    return this.ephemeralCollection.delete(ephemeralKey(repoName, name));
  }
}

function ephemeralKey(repoName: string, name: string): string {
  return workspaceKey(FleetIdentifierSchema.parse(repoName), FleetIdentifierSchema.parse(name));
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
