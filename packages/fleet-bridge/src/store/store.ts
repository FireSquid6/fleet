/**
 * store.ts — the bridge's JSON-file persistence.
 *
 * Replaces the former drizzle + `bun:sqlite` stack. The bridge only owns two tiny,
 * flat, `name`-keyed collections — the ship roster and the repo registry — so they
 * live as in-memory `Map`s persisted to `ships.json` / `repos.json` under the
 * configured `dataDirectory`. Every mutation rewrites the whole file; single-process,
 * single-instance use makes a full-file `Bun.write` atomic enough (no transactions).
 */

import { join } from "node:path";
import type { Repo } from "fleet-protocol";

/** A registered fleet member: its name and the endpoint the bridge connects to. */
export interface Ship {
  name: string;
  url: string;
}

export class Store {
  private ships = new Map<string, Ship>();
  private repos = new Map<string, Repo>();
  private loaded = false;

  constructor(private readonly dataDirectory: string) {}

  /**
   * Read `ships.json` / `repos.json` into memory. Idempotent: a no-op once loaded, so
   * callers that seed in-memory before `FleetManager.init()` runs aren't clobbered by
   * init's own `load()`.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    for (const ship of await this.readFile<Ship>("ships.json")) this.ships.set(ship.name, ship);
    for (const repo of await this.readFile<Repo>("repos.json")) this.repos.set(repo.name, repo);
    this.loaded = true;
  }

  private async readFile<T>(name: string): Promise<T[]> {
    const file = Bun.file(join(this.dataDirectory, name));
    if (!(await file.exists())) return [];
    return (await file.json()) as T[];
  }

  private persistShips(): Promise<number> {
    return Bun.write(join(this.dataDirectory, "ships.json"), stringify([...this.ships.values()]));
  }

  private persistRepos(): Promise<number> {
    return Bun.write(join(this.dataDirectory, "repos.json"), stringify([...this.repos.values()]));
  }

  // --- ships ----------------------------------------------------------------

  async getAllShips(): Promise<Ship[]> {
    return [...this.ships.values()];
  }

  async getShip(name: string): Promise<Ship | undefined> {
    return this.ships.get(name);
  }

  async createShip(ship: Ship): Promise<Ship> {
    this.ships.set(ship.name, ship);
    await this.persistShips();
    return ship;
  }

  /** Insert a ship, or overwrite its `url` if the name already exists. */
  async upsertShip(ship: Ship): Promise<Ship> {
    return this.createShip(ship);
  }

  async updateShip(name: string, values: Partial<Omit<Ship, "name">>): Promise<Ship | undefined> {
    const existing = this.ships.get(name);
    if (!existing) return undefined;
    const updated = { ...existing, ...values };
    this.ships.set(name, updated);
    await this.persistShips();
    return updated;
  }

  async deleteShip(name: string): Promise<Ship | undefined> {
    const existing = this.ships.get(name);
    if (!existing) return undefined;
    this.ships.delete(name);
    await this.persistShips();
    return existing;
  }

  /** Overwrite the entire ship roster (clear, then set all) in a single rewrite. */
  async replaceAllShips(ships: Ship[]): Promise<void> {
    this.ships = new Map(ships.map((ship) => [ship.name, ship]));
    await this.persistShips();
  }

  // --- repos ----------------------------------------------------------------

  async getAllRepos(): Promise<Repo[]> {
    return [...this.repos.values()];
  }

  async getRepo(name: string): Promise<Repo | undefined> {
    return this.repos.get(name);
  }

  async createRepo(repo: Repo): Promise<Repo> {
    this.repos.set(repo.name, repo);
    await this.persistRepos();
    return repo;
  }

  /** Insert a repo, or overwrite its `url`/`provider` if the name already exists. */
  async upsertRepo(repo: Repo): Promise<Repo> {
    return this.createRepo(repo);
  }

  async updateRepo(name: string, values: Partial<Omit<Repo, "name">>): Promise<Repo | undefined> {
    const existing = this.repos.get(name);
    if (!existing) return undefined;
    const updated = { ...existing, ...values };
    this.repos.set(name, updated);
    await this.persistRepos();
    return updated;
  }

  async deleteRepo(name: string): Promise<Repo | undefined> {
    const existing = this.repos.get(name);
    if (!existing) return undefined;
    this.repos.delete(name);
    await this.persistRepos();
    return existing;
  }
}

const stringify = (value: unknown): string => JSON.stringify(value, null, 2);
