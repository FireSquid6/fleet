import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";
import type { BridgeConfig } from "../config";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";

/** Resolve a migrations dir under `apps/fleet-bridge/drizzle`, cwd-independently. */
const migrations = (name: string) => fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url));

export function getDb(config: BridgeConfig) {
  let sqlite: Database;
  let migrationsFolder: string;
  if (config.ephemeralDb === true) {
    sqlite = new Database(":memory:");
    // Regenerated from an empty DB before every test run (tests/setup.ts).
    migrationsFolder = migrations("ephemeral");
  } else {
    fs.mkdirSync(config.dataDirectory, { recursive: true });
    sqlite = new Database(path.join(config.dataDirectory, "bridge.sqlite"));
    migrationsFolder = migrations("dev");
  }

  const db = drizzle(sqlite);
  // migrate() is synchronous and idempotent (tracks applied migrations). It runs on
  // every getDb() — required for :memory: DBs, which start schemaless. Don't call
  // getDb() concurrently against the same file path: the migrations would race.
  migrate(db, { migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof getDb>;
