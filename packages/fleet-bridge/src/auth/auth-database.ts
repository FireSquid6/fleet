import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { z } from "zod";

export const SCHEMA_VERSION = 1;

/**
 * Storage rows, deliberately not in `fleet-protocol`: they never cross a
 * process boundary. Every read parses through them, so the declared shape and
 * what sqlite actually holds cannot quietly diverge.
 */
export const UserRowSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  password_hash: z.string(),
  role: z.enum(["admin", "member"]),
  created_at: z.number(),
});

export type UserRow = z.infer<typeof UserRowSchema>;

export const SessionRowSchema = z.object({
  token_hash: z.string(),
  user_id: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  last_used_at: z.number(),
});

export type SessionRow = z.infer<typeof SessionRowSchema>;

export const ShipCredentialsRowSchema = z.object({
  ship_name: z.string(),
  ship_token_hash: z.string(),
  bridge_token: z.string(),
  agent_token_hash: z.string().nullable(),
  created_at: z.number(),
});

export type ShipCredentialsRow = z.infer<typeof ShipCredentialsRowSchema>;

type ColumnSpec = { name: string; type: "TEXT" | "INTEGER"; notNull: boolean; pk: boolean };

const column = (
  name: string,
  type: "TEXT" | "INTEGER",
  flags?: { notNull?: boolean; pk?: boolean },
): ColumnSpec => ({ name, type, notNull: flags?.notNull ?? false, pk: flags?.pk ?? false });

/**
 * What `PRAGMA table_info` must report for the tables `SCHEMA_SQL` creates.
 * It only reports name/type/notnull/pk, so the `CREATE` statements below stay
 * literal and keep the parts it cannot see (UNIQUE, COLLATE, CHECK, REFERENCES).
 * `migrate()` checks the live file against this and this against the row
 * schemas, so no two of the three can drift apart unnoticed.
 */
const EXPECTED_COLUMNS: Record<string, ColumnSpec[]> = {
  version: [column("version", "INTEGER", { notNull: true })],
  users: [
    column("id", "TEXT", { pk: true }),
    column("username", "TEXT", { notNull: true }),
    column("email", "TEXT", { notNull: true }),
    column("password_hash", "TEXT", { notNull: true }),
    column("role", "TEXT", { notNull: true }),
    column("created_at", "INTEGER", { notNull: true }),
  ],
  sessions: [
    column("token_hash", "TEXT", { pk: true }),
    column("user_id", "TEXT", { notNull: true }),
    column("created_at", "INTEGER", { notNull: true }),
    column("expires_at", "INTEGER", { notNull: true }),
    column("last_used_at", "INTEGER", { notNull: true }),
  ],
  ship_credentials: [
    column("ship_name", "TEXT", { pk: true }),
    column("ship_token_hash", "TEXT", { notNull: true }),
    column("bridge_token", "TEXT", { notNull: true }),
    column("agent_token_hash", "TEXT"),
    column("created_at", "INTEGER", { notNull: true }),
  ],
};

const ROW_SCHEMAS = {
  users: UserRowSchema,
  sessions: SessionRowSchema,
  ship_credentials: ShipCredentialsRowSchema,
} as const;

const SCHEMA_SQL = `
CREATE TABLE version (version INTEGER NOT NULL);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE TABLE ship_credentials (
  ship_name TEXT PRIMARY KEY,
  ship_token_hash TEXT NOT NULL,
  bridge_token TEXT NOT NULL,
  agent_token_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ship_credentials_ship_token ON ship_credentials(ship_token_hash);
CREATE INDEX ship_credentials_agent_token ON ship_credentials(agent_token_hash);
`;

function prepareStatements(db: Database) {
  return {
    countUsers: db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM users"),
    countAdmins: db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"),
    insertUser: db.query<void, [string, string, string, string, string, number]>(
      "INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    findUserById: db.query<unknown, [string]>("SELECT * FROM users WHERE id = ?"),
    findUserByUsername: db.query<unknown, [string]>("SELECT * FROM users WHERE username = ?"),
    findUserByEmail: db.query<unknown, [string]>("SELECT * FROM users WHERE email = ?"),
    listUsers: db.query<unknown, []>("SELECT * FROM users ORDER BY created_at, username"),
    deleteUser: db.query<void, [string]>("DELETE FROM users WHERE id = ?"),
    updatePasswordHash: db.query<void, [string, string]>("UPDATE users SET password_hash = ? WHERE id = ?"),
    updateEmail: db.query<void, [string, string]>("UPDATE users SET email = ? WHERE id = ?"),
    updateRole: db.query<void, [string, string]>("UPDATE users SET role = ? WHERE id = ?"),

    insertSession: db.query<void, [string, string, number, number, number]>(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
    ),
    findSession: db.query<unknown, [string]>("SELECT * FROM sessions WHERE token_hash = ?"),
    touchSession: db.query<void, [number, string]>("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?"),
    deleteSession: db.query<void, [string]>("DELETE FROM sessions WHERE token_hash = ?"),
    deleteSessionsForUser: db.query<void, [string]>("DELETE FROM sessions WHERE user_id = ?"),
    deleteExpiredSessions: db.query<void, [number]>("DELETE FROM sessions WHERE expires_at <= ?"),

    upsertShipCredentials: db.query<void, [string, string, string, string | null, number]>(
      `INSERT INTO ship_credentials (ship_name, ship_token_hash, bridge_token, agent_token_hash, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ship_name) DO UPDATE SET
         ship_token_hash = excluded.ship_token_hash,
         bridge_token = excluded.bridge_token,
         agent_token_hash = excluded.agent_token_hash`,
    ),
    findShipCredentials: db.query<unknown, [string]>("SELECT * FROM ship_credentials WHERE ship_name = ?"),
    findShipByShipTokenHash: db.query<unknown, [string]>(
      "SELECT * FROM ship_credentials WHERE ship_token_hash = ?",
    ),
    findShipByAgentTokenHash: db.query<unknown, [string]>(
      "SELECT * FROM ship_credentials WHERE agent_token_hash = ?",
    ),
    setAgentTokenHash: db.query<void, [string | null, string]>(
      "UPDATE ship_credentials SET agent_token_hash = ? WHERE ship_name = ?",
    ),
    deleteShipCredentials: db.query<void, [string]>("DELETE FROM ship_credentials WHERE ship_name = ?"),
  } as const;
}

type Statements = ReturnType<typeof prepareStatements>;

const describeColumn = (c: ColumnSpec): string =>
  `${c.name} ${c.type}${c.notNull ? " NOT NULL" : ""}${c.pk ? " PRIMARY KEY" : ""}`;

/** The integrity boundary: nothing leaves sqlite without matching its row schema. */
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T | undefined {
  return row === null || row === undefined ? undefined : schema.parse(row);
}

/**
 * Every SQL statement fleet's authentication uses. Policy (hashing, expiry,
 * last-admin rules) belongs one layer up in `AuthService`; this class only
 * reads and writes rows.
 */
export class AuthDatabase {
  private readonly db: Database;
  /** Prepared lazily: the tables do not exist until `migrate()` has run. */
  private statements: Statements | undefined;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    // sqlite creates the file 0644 and it holds password hashes and bridge tokens.
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  migrate(): void {
    const existing = this.readVersion();
    if (existing === undefined) {
      this.db.transaction(() => {
        this.db.exec(SCHEMA_SQL);
        this.db.run("INSERT INTO version (version) VALUES (?)", [SCHEMA_VERSION]);
      })();
    } else if (existing > SCHEMA_VERSION) {
      throw new Error(
        `auth database schema version ${existing} is newer than this fleet supports (${SCHEMA_VERSION})`,
      );
    }
    this.verifySchema();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * `BEGIN IMMEDIATE`: takes the write lock up front so a read-then-write guard
   * cannot interleave with another process sharing the database file.
   */
  immediateTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  close(): void {
    this.statements = undefined;
    this.db.close();
  }

  countUsers(): number {
    return this.s.countUsers.get()?.count ?? 0;
  }

  countAdmins(): number {
    return this.s.countAdmins.get()?.count ?? 0;
  }

  insertUser(row: UserRow): void {
    this.s.insertUser.run(row.id, row.username, row.email, row.password_hash, row.role, row.created_at);
  }

  findUserById(id: string): UserRow | undefined {
    return parseRow(UserRowSchema, this.s.findUserById.get(id));
  }

  /** Case-insensitive: the `username` column is `COLLATE NOCASE`. */
  findUserByUsername(username: string): UserRow | undefined {
    return parseRow(UserRowSchema, this.s.findUserByUsername.get(username));
  }

  /** Case-insensitive: the `email` column is `COLLATE NOCASE`. */
  findUserByEmail(email: string): UserRow | undefined {
    return parseRow(UserRowSchema, this.s.findUserByEmail.get(email));
  }

  listUsers(): UserRow[] {
    return this.s.listUsers.all().map((row) => UserRowSchema.parse(row));
  }

  deleteUser(id: string): void {
    this.s.deleteUser.run(id);
  }

  updatePasswordHash(id: string, passwordHash: string): void {
    this.s.updatePasswordHash.run(passwordHash, id);
  }

  updateEmail(id: string, email: string): void {
    this.s.updateEmail.run(email, id);
  }

  updateRole(id: string, role: UserRow["role"]): void {
    this.s.updateRole.run(role, id);
  }

  insertSession(row: SessionRow): void {
    this.s.insertSession.run(row.token_hash, row.user_id, row.created_at, row.expires_at, row.last_used_at);
  }

  findSession(tokenHash: string): SessionRow | undefined {
    return parseRow(SessionRowSchema, this.s.findSession.get(tokenHash));
  }

  touchSession(tokenHash: string, lastUsedAt: number): void {
    this.s.touchSession.run(lastUsedAt, tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.s.deleteSession.run(tokenHash);
  }

  deleteSessionsForUser(userId: string): void {
    this.s.deleteSessionsForUser.run(userId);
  }

  deleteExpiredSessions(now: number): void {
    this.s.deleteExpiredSessions.run(now);
  }

  /** Leaves `created_at` at its original value when the row already exists. */
  upsertShipCredentials(row: ShipCredentialsRow): void {
    this.s.upsertShipCredentials.run(
      row.ship_name,
      row.ship_token_hash,
      row.bridge_token,
      row.agent_token_hash,
      row.created_at,
    );
  }

  findShipCredentials(shipName: string): ShipCredentialsRow | undefined {
    return parseRow(ShipCredentialsRowSchema, this.s.findShipCredentials.get(shipName));
  }

  findShipByShipTokenHash(shipTokenHash: string): ShipCredentialsRow | undefined {
    return parseRow(ShipCredentialsRowSchema, this.s.findShipByShipTokenHash.get(shipTokenHash));
  }

  findShipByAgentTokenHash(agentTokenHash: string): ShipCredentialsRow | undefined {
    return parseRow(ShipCredentialsRowSchema, this.s.findShipByAgentTokenHash.get(agentTokenHash));
  }

  setAgentTokenHash(shipName: string, agentTokenHash: string | null): void {
    this.s.setAgentTokenHash.run(agentTokenHash, shipName);
  }

  deleteShipCredentials(shipName: string): void {
    this.s.deleteShipCredentials.run(shipName);
  }

  private get s(): Statements {
    return (this.statements ??= prepareStatements(this.db));
  }

  /** Rejects a hand-edited or drifted database file at startup, not at the first failed query. */
  private verifySchema(): void {
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const info = this.db
        .query<{ name: string; type: string; notnull: number; pk: number }, []>(`PRAGMA table_info(${table})`)
        .all();
      if (info.length === 0) throw new Error(`auth database is missing the ${table} table`);

      const actual = info
        .map((row) =>
          describeColumn({
            name: row.name,
            type: row.type as ColumnSpec["type"],
            notNull: row.notnull !== 0,
            pk: row.pk !== 0,
          }),
        )
        .join(", ");
      const wanted = expected.map(describeColumn).join(", ");
      if (actual !== wanted) {
        throw new Error(
          `auth database table ${table} does not match the schema: expected (${wanted}), found (${actual})`,
        );
      }

      const schema = ROW_SCHEMAS[table as keyof typeof ROW_SCHEMAS];
      if (schema && Object.keys(schema.shape).join(", ") !== expected.map((c) => c.name).join(", ")) {
        throw new Error(`the row schema for ${table} does not match its columns`);
      }
    }
  }

  private readVersion(): number | undefined {
    const table = this.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'version'")
      .get();
    if (!table) return undefined;
    const row = this.db.query<{ version: number }, []>("SELECT version FROM version LIMIT 1").get();
    if (!row) throw new Error("auth database has a version table but no version row");
    return row.version;
  }
}
