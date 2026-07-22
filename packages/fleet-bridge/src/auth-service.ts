/**
 * auth-service.ts — the bridge's authentication core.
 *
 * The single gate between the API layer and the auth persistence in `Store`
 * (routes call `auth.*`, never `store.*`, per the repo's "routes never touch
 * persistence directly" rule). Owns password hashing, opaque session lifecycle,
 * and the short-lived WebSocket tickets used to authenticate the terminal
 * stream (browsers can't set headers on a WebSocket — see api/auth.ts).
 *
 * Errors are thrown as `BridgeError` so the existing `mapError` surfaces the
 * right HTTP status unchanged.
 */

import { BridgeError } from "./fleet-manager";
import { UserAlreadyExistsError, type Store } from "./store/store";

export interface AuthConfig {
  /** Session lifetime in ms; feeds `expiresAt` and the cookie `Max-Age`. */
  sessionTtlMs: number;
}

/** The authenticated principal exposed to routes and the guard. */
export interface SessionUser {
  id: string;
  username: string;
}

/** WebSocket tickets are single-use and short-lived; long enough to cover an immediate WS open. */
const TICKET_TTL_MS = 30_000;

interface Ticket {
  userId: string;
  expiresAt: number;
}

export class AuthService {
  /** Ephemeral, single-use WS tickets. In-memory only — not worth persisting for a 30s TTL. */
  private readonly tickets = new Map<string, Ticket>();
  /** Argon2 hash verified against on unknown-user logins to flatten timing (anti-enumeration). */
  private dummyHash: string | undefined;

  constructor(
    private readonly store: Store,
    private readonly config: AuthConfig,
  ) {}

  async userCount(): Promise<number> {
    return this.store.countUsers();
  }

  /** Create a local account. Throws `BridgeError(409)` if the username is taken. */
  async createUser(username: string, password: string): Promise<SessionUser> {
    if (!username || !password) throw new BridgeError("username and password are required", 400);
    const passwordHash = await Bun.password.hash(password);
    try {
      const user = await this.store.createUser({
        id: crypto.randomUUID(),
        username,
        passwordHash,
        createdAt: Date.now(),
      });
      return { id: user.id, username: user.username };
    } catch (err) {
      if (err instanceof UserAlreadyExistsError) throw new BridgeError(`user already exists: ${username}`, 409);
      throw err;
    }
  }

  /** Verify credentials. Throws `BridgeError(401)` on any mismatch (message never reveals which). */
  async verifyLogin(username: string, password: string): Promise<SessionUser> {
    const user = await this.store.getUserByUsername(username);
    if (!user) {
      // Spend the same work as a real verify so an unknown username isn't a fast path.
      await Bun.password.verify(password, await this.getDummyHash());
      throw new BridgeError("invalid username or password", 401);
    }
    if (!(await Bun.password.verify(password, user.passwordHash))) {
      throw new BridgeError("invalid username or password", 401);
    }
    return { id: user.id, username: user.username };
  }

  /** Mint a persisted session and return its opaque token (the cookie value). */
  async createSession(userId: string): Promise<string> {
    const token = crypto.randomUUID() + crypto.randomUUID();
    const now = Date.now();
    await this.store.createSession({ token, userId, createdAt: now, expiresAt: now + this.config.sessionTtlMs });
    return token;
  }

  /** Resolve a session token to its user, or `null` if missing/expired. Prunes an expired hit lazily. */
  async resolveSession(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const session = await this.store.getSession(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      await this.store.deleteSession(token);
      return null;
    }
    const user = await this.store.getUserById(session.userId);
    if (!user) return null;
    return { id: user.id, username: user.username };
  }

  async revokeSession(token: string): Promise<void> {
    await this.store.deleteSession(token);
  }

  /** Issue a one-time ticket a client can pass as `?ticket=` when opening the terminal WS. */
  issueTicket(userId: string): string {
    this.pruneTickets();
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  /** Validate and consume a ticket. Returns the owning user id, or `null` if invalid/expired. Single-use. */
  consumeTicket(ticket: string | undefined): string | null {
    if (!ticket) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.userId;
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(ticket);
    }
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHash) this.dummyHash = await Bun.password.hash(crypto.randomUUID());
    return this.dummyHash;
  }
}
