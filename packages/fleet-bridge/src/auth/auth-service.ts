import { SQLiteError } from "bun:sqlite";
import {
  EmailSchema,
  PasswordSchema,
  UsernameSchema,
  parseFleetIdentifier,
  type Role,
  type User,
} from "fleet-protocol";
import { z } from "zod";
import type { AuthDatabase, UserRow } from "./auth-database";

/**
 * The authority on what a valid username, email and password are. Parsed as
 * fields rather than bare values so a failure names the field it came from —
 * `mapError` has nothing else to go on when it renders the 400.
 */
const UserFieldsSchema = z.object({
  username: UsernameSchema,
  email: EmailSchema,
  password: PasswordSchema,
});

const EmailFieldSchema = UserFieldsSchema.pick({ email: true });
const PasswordFieldSchema = UserFieldsSchema.pick({ password: true });

/** Carries the HTTP status the auth layer wants, so `mapError` needs one `instanceof`. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super("invalid username or password", 401);
    this.name = "InvalidCredentialsError";
  }
}

export class UnauthenticatedError extends AuthError {
  constructor(message = "authentication required") {
    super(message, 401);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = "forbidden") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

export class UserAlreadyExistsError extends AuthError {
  constructor(readonly username: string) {
    super(`user already exists: ${username}`, 409);
    this.name = "UserAlreadyExistsError";
  }
}

export class EmailAlreadyExistsError extends AuthError {
  constructor(readonly email: string) {
    super(`email already in use: ${email}`, 409);
    this.name = "EmailAlreadyExistsError";
  }
}

export class UserNotFoundError extends AuthError {
  constructor(readonly username: string) {
    super(`user not found: ${username}`, 404);
    this.name = "UserNotFoundError";
  }
}

export class LastAdminError extends AuthError {
  constructor(readonly username: string) {
    super(`cannot remove the last admin: ${username}`, 409);
    this.name = "LastAdminError";
  }
}

export class AlreadyBootstrappedError extends AuthError {
  constructor() {
    super("the first admin has already been created", 409);
    this.name = "AlreadyBootstrappedError";
  }
}

export type Principal =
  | { kind: "user"; id: string; username: string; role: Role }
  | { kind: "ship"; ship: string }
  | { kind: "ship-agent"; ship: string };

/** Absolute, never extended: a session dies 30 days after it was issued. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Authentication runs on every request, so writing `last_used_at` on each hit
 * would fsync the database per API call. It is a coarse liveness signal, not an
 * audit log, so it is only refreshed once per interval.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;
export const WS_TICKET_TTL_MS = 30_000;

const TOKEN_BYTES = 32;

type WsTicket = { principal: Principal; expiresAt: number };

export class AuthService {
  private readonly now: () => number;
  /**
   * Tickets are deliberately not persisted: they live for 30 seconds on the
   * WebSocket handshake path, and losing them on restart costs a reconnect.
   */
  private readonly tickets = new Map<string, WsTicket>();

  constructor(
    private readonly db: AuthDatabase,
    deps?: { now?: () => number },
  ) {
    this.now = deps?.now ?? (() => Date.now());
  }

  hasUsers(): boolean {
    return this.db.countUsers() > 0;
  }

  async createUser(input: { username: string; email: string; password: string; role?: Role }): Promise<User> {
    const row = await this.buildUserRow(input, input.role ?? "member");
    this.db.immediateTransaction(() => {
      this.assertUnique(row);
      this.insertUserRow(row);
    });
    return toUser(row);
  }

  async createFirstAdmin(input: { username: string; email: string; password: string }): Promise<User> {
    const row = await this.buildUserRow(input, "admin");
    this.db.immediateTransaction(() => {
      if (this.db.countUsers() > 0) throw new AlreadyBootstrappedError();
      this.insertUserRow(row);
    });
    return toUser(row);
  }

  async login(username: string, password: string): Promise<{ token: string; user: User }> {
    const row = this.db.findUserByUsername(username);
    if (!row) {
      // Verify against a throwaway hash so a missing user costs roughly the same
      // as a wrong password and cannot be told apart by timing.
      await Bun.password.verify(password, await dummyPasswordHash()).catch(() => false);
      throw new InvalidCredentialsError();
    }
    const matches = await Bun.password.verify(password, row.password_hash).catch(() => false);
    if (!matches) throw new InvalidCredentialsError();

    const token = generateToken();
    const now = this.now();
    this.db.insertSession({
      token_hash: hashToken(token),
      user_id: row.id,
      created_at: now,
      expires_at: now + SESSION_TTL_MS,
      last_used_at: now,
    });
    return { token, user: toUser(row) };
  }

  logout(token: string): void {
    this.db.deleteSession(hashToken(token));
  }

  /** Resolves an `Authorization` header to a principal. Returns null rather than throwing. */
  authenticate(header: string | null | undefined): Principal | null {
    const token = parseBearer(header);
    if (!token) return null;
    const hash = hashToken(token);

    const session = this.db.findSession(hash);
    if (session) {
      const now = this.now();
      if (session.expires_at <= now) {
        this.db.deleteSession(hash);
        return null;
      }
      const user = this.db.findUserById(session.user_id);
      if (!user) return null;
      if (now - session.last_used_at >= SESSION_TOUCH_INTERVAL_MS) this.db.touchSession(hash, now);
      return { kind: "user", id: user.id, username: user.username, role: user.role };
    }

    const ship = this.db.findShipByShipTokenHash(hash);
    if (ship) return { kind: "ship", ship: ship.ship_name };

    const agent = this.db.findShipByAgentTokenHash(hash);
    if (agent) return { kind: "ship-agent", ship: agent.ship_name };

    return null;
  }

  listUsers(): User[] {
    return this.db.listUsers().map(toUser);
  }

  getUser(username: string): User | undefined {
    const row = this.db.findUserByUsername(username);
    return row ? toUser(row) : undefined;
  }

  deleteUser(username: string): void {
    const row = this.requireUser(username);
    this.db.transaction(() => {
      if (row.role === "admin" && this.db.countAdmins() <= 1) throw new LastAdminError(row.username);
      this.db.deleteUser(row.id);
    });
  }

  setRole(username: string, role: Role): User {
    const row = this.requireUser(username);
    this.db.transaction(() => {
      if (row.role === "admin" && role !== "admin" && this.db.countAdmins() <= 1) {
        throw new LastAdminError(row.username);
      }
      this.db.updateRole(row.id, role);
    });
    return toUser({ ...row, role });
  }

  setEmail(username: string, email: string): User {
    const row = this.requireUser(username);
    const { email: next } = EmailFieldSchema.parse({ email });
    this.db.immediateTransaction(() => {
      const owner = this.db.findUserByEmail(next);
      if (owner && owner.id !== row.id) throw new EmailAlreadyExistsError(next);
      this.db.updateEmail(row.id, next);
    });
    return toUser({ ...row, email: next });
  }

  async setPassword(username: string, password: string): Promise<void> {
    const row = this.requireUser(username);
    const passwordHash = await Bun.password.hash(PasswordFieldSchema.parse({ password }).password);
    this.db.transaction(() => {
      this.db.updatePasswordHash(row.id, passwordHash);
      this.db.deleteSessionsForUser(row.id);
    });
  }

  issueWsTicket(principal: Principal): { ticket: string; expiresAt: number } {
    const now = this.now();
    for (const [key, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(key);
    }
    const ticket = generateToken();
    const expiresAt = now + WS_TICKET_TTL_MS;
    this.tickets.set(ticket, { principal, expiresAt });
    return { ticket, expiresAt };
  }

  redeemWsTicket(ticket: string): Principal | null {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    return entry.expiresAt <= this.now() ? null : entry.principal;
  }

  /** Returns both secrets in cleartext once; only the ship token is recoverable afterwards. */
  createShipCredentials(shipName: string): { shipToken: string; bridgeToken: string } {
    const shipToken = generateToken();
    const bridgeToken = generateToken();
    this.setShipCredentials(shipName, { shipToken, bridgeToken });
    return { shipToken, bridgeToken };
  }

  setShipCredentials(shipName: string, credentials: { shipToken: string; bridgeToken: string }): void {
    this.db.upsertShipCredentials({
      ship_name: parseFleetIdentifier(shipName),
      ship_token_hash: hashToken(credentials.shipToken),
      // Cleartext, unlike every other secret here: the bridge has to present
      // this token to the ship on each call, so it cannot be a one-way hash.
      bridge_token: credentials.bridgeToken,
      agent_token_hash: null,
      created_at: this.now(),
    });
  }

  bridgeTokenFor(shipName: string): string | undefined {
    return this.db.findShipCredentials(shipName)?.bridge_token;
  }

  mintShipAgentToken(shipName: string): string {
    if (!this.db.findShipCredentials(shipName)) {
      throw new Error(`no credentials registered for ship: ${shipName}`);
    }
    const token = generateToken();
    this.db.setAgentTokenHash(shipName, hashToken(token));
    return token;
  }

  deleteShipCredentials(shipName: string): void {
    this.db.deleteShipCredentials(shipName);
  }

  private requireUser(username: string): UserRow {
    const row = this.db.findUserByUsername(username);
    if (!row) throw new UserNotFoundError(username);
    return row;
  }

  private async buildUserRow(
    input: { username: string; email: string; password: string },
    role: Role,
  ): Promise<UserRow> {
    const { username, email, password } = UserFieldsSchema.parse(input);
    const passwordHash = await Bun.password.hash(password);
    return {
      id: crypto.randomUUID(),
      username,
      email,
      password_hash: passwordHash,
      role,
      created_at: this.now(),
    };
  }

  private assertUnique(row: UserRow): void {
    if (this.db.findUserByUsername(row.username)) throw new UserAlreadyExistsError(row.username);
    if (this.db.findUserByEmail(row.email)) throw new EmailAlreadyExistsError(row.email);
  }

  private insertUserRow(row: UserRow): void {
    try {
      this.db.insertUser(row);
    } catch (error) {
      // Backstop only: callers check both unique columns under a write lock
      // first. Sqlite names the column that collided, so use it when it is
      // there and let anything else surface as itself rather than blaming a
      // field that may not be the one at fault.
      if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_CONSTRAINT")) {
        if (error.message.includes("users.username")) throw new UserAlreadyExistsError(row.username);
        if (error.message.includes("users.email")) throw new EmailAlreadyExistsError(row.email);
      }
      throw error;
    }
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  };
}


function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

let dummyHash: Promise<string> | undefined;

function dummyPasswordHash(): Promise<string> {
  return (dummyHash ??= Bun.password.hash(generateToken()));
}

/** The one place an `Authorization` header is split; routes that need the raw token reuse it. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}
