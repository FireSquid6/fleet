import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthDatabase, type UserRow } from "../src/auth/auth-database";

describe("AuthDatabase", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function tempPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "fleet-auth-db-"));
    directories.push(directory);
    return join(directory, "auth.sqlite");
  }

  function tamper(path: string, sql: string): void {
    const raw = new Database(path, { strict: true });
    try {
      raw.exec(sql);
    } finally {
      raw.close();
    }
  }

  function readVersions(path: string): number[] {
    const raw = new Database(path, { readonly: true, strict: true });
    try {
      return raw.query<{ version: number }, []>("SELECT version FROM version").all().map((row) => row.version);
    } finally {
      raw.close();
    }
  }

  test("migrate creates version 1 and is idempotent", async () => {
    const path = await tempPath();
    const db = new AuthDatabase(path);
    db.migrate();
    db.migrate();
    db.insertUser({
      id: "u1",
      username: "ada",
      email: "ada@fleet.test",
      password_hash: "hash",
      role: "admin",
      created_at: 1,
    });
    db.migrate();
    expect(db.listUsers()).toHaveLength(1);
    db.close();

    expect(readVersions(path)).toEqual([1]);
  });

  test("rejects a database written by a newer fleet", async () => {
    const path = await tempPath();
    const raw = new Database(path, { create: true, strict: true });
    raw.exec("CREATE TABLE version (version INTEGER NOT NULL); INSERT INTO version (version) VALUES (2)");
    raw.close();

    const db = new AuthDatabase(path);
    expect(() => db.migrate()).toThrow(/newer than this fleet supports/);
    db.close();
  });

  test("locks the database file down to 0600", async () => {
    const path = await tempPath();
    const db = new AuthDatabase(path);
    db.migrate();
    db.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("migrate rejects a table that drifted out from under the class", async () => {
    const dropped = await tempPath();
    const first = new AuthDatabase(dropped);
    first.migrate();
    first.close();
    // Not `email`: sqlite refuses to drop a column carrying a UNIQUE constraint.
    tamper(dropped, "ALTER TABLE users DROP COLUMN password_hash");
    expect(() => new AuthDatabase(dropped).migrate()).toThrow(/table users does not match the schema/);

    const added = await tempPath();
    const second = new AuthDatabase(added);
    second.migrate();
    second.close();
    tamper(added, "ALTER TABLE sessions ADD COLUMN stray TEXT");
    expect(() => new AuthDatabase(added).migrate()).toThrow(/table sessions does not match the schema/);

    const missing = await tempPath();
    const third = new AuthDatabase(missing);
    third.migrate();
    third.close();
    tamper(missing, "DROP TABLE ship_credentials");
    expect(() => new AuthDatabase(missing).migrate()).toThrow(/missing the ship_credentials table/);
  });

  test("a row that does not match its schema is rejected on read", async () => {
    const path = await tempPath();
    const db = new AuthDatabase(path);
    db.migrate();
    db.close();
    tamper(
      path,
      `INSERT INTO users (id, username, email, password_hash, role, created_at)
       VALUES ('u1', 'ada', 'ada@fleet.test', 'hash', 'admin', 'the day before yesterday')`,
    );

    const reopened = new AuthDatabase(path);
    reopened.migrate();
    expect(() => reopened.findUserByUsername("ada")).toThrow();
    expect(() => reopened.listUsers()).toThrow();
    expect(reopened.findUserByUsername("ghost")).toBeUndefined();
    reopened.close();
  });

  test("deleting a user cascades to their sessions", () => {
    const db = new AuthDatabase(":memory:");
    db.migrate();
    db.insertUser({
      id: "u1",
      username: "ada",
      email: "ada@fleet.test",
      password_hash: "hash",
      role: "member",
      created_at: 1,
    });
    db.insertSession({ token_hash: "h1", user_id: "u1", created_at: 1, expires_at: 10, last_used_at: 1 });
    expect(db.findSession("h1")).toBeDefined();

    db.deleteUser("u1");
    expect(db.findSession("h1")).toBeUndefined();
    db.close();
  });

  test("rejects a session for an unknown user, an unknown role, and a duplicate email", () => {
    const db = new AuthDatabase(":memory:");
    db.migrate();
    const ada: UserRow = {
      id: "u1",
      username: "ada",
      email: "ada@fleet.test",
      password_hash: "hash",
      role: "member",
      created_at: 1,
    };
    db.insertUser(ada);

    expect(() =>
      db.insertSession({ token_hash: "h1", user_id: "ghost", created_at: 1, expires_at: 10, last_used_at: 1 }),
    ).toThrow();
    expect(() =>
      db.insertUser({ ...ada, id: "u2", username: "grace", role: "root" as UserRow["role"] }),
    ).toThrow();
    expect(() => db.insertUser({ ...ada, id: "u2", username: "grace", email: "ADA@FLEET.TEST" })).toThrow(
      /UNIQUE constraint failed: users\.email/,
    );
    expect(db.findUserByEmail("Ada@Fleet.Test")?.id).toBe("u1");

    db.close();
  });
});
