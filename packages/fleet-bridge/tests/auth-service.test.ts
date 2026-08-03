import { beforeEach, describe, expect, test } from "bun:test";
import { AuthDatabase } from "../src/auth/auth-database";
import {
  AlreadyBootstrappedError,
  AuthService,
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  LastAdminError,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
  UserAlreadyExistsError,
  UserNotFoundError,
  WS_TICKET_TTL_MS,
  type Principal,
} from "../src/auth/auth-service";

const PASSWORD = "correct-horse-battery";

describe("AuthService", () => {
  let db: AuthDatabase;
  let auth: AuthService;
  let clock: number;

  beforeEach(() => {
    db = new AuthDatabase(":memory:");
    db.migrate();
    clock = 1_700_000_000_000;
    auth = new AuthService(db, { now: () => clock });
  });

  const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

  test("createFirstAdmin bootstraps exactly once, with an email", async () => {
    expect(auth.hasUsers()).toBe(false);
    const admin = await auth.createFirstAdmin({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    expect(admin).toMatchObject({ role: "admin", email: "ada@fleet.test" });
    expect(auth.hasUsers()).toBe(true);

    await expect(
      auth.createFirstAdmin({ username: "grace", email: "grace@fleet.test", password: PASSWORD }),
    ).rejects.toBeInstanceOf(AlreadyBootstrappedError);
    expect(auth.listUsers()).toHaveLength(1);
  });

  test("usernames are unique case-insensitively", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    await expect(
      auth.createUser({ username: "ada", email: "other@fleet.test", password: PASSWORD }),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
    await expect(
      auth.createUser({ username: "ADA", email: "another@fleet.test", password: PASSWORD }),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
    expect(auth.getUser("AdA")?.username).toBe("ada");
    expect(auth.listUsers()).toHaveLength(1);
  });

  test("emails are required, valid, and unique case-insensitively", async () => {
    const ada = await auth.createUser({ username: "ada", email: "Ada@Fleet.test", password: PASSWORD });
    expect(ada.email).toBe("Ada@Fleet.test");

    await expect(
      auth.createUser({ username: "grace", email: "ada@fleet.test", password: PASSWORD }),
    ).rejects.toBeInstanceOf(EmailAlreadyExistsError);
    await expect(
      auth.createUser({ username: "grace", email: "not-an-email", password: PASSWORD }),
    ).rejects.toThrow();
    await expect(
      auth.createUser({ username: "grace", email: "", password: PASSWORD }),
    ).rejects.toThrow();
    expect(auth.listUsers()).toHaveLength(1);
  });

  test("setEmail round-trips and refuses a collision", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    await auth.createUser({ username: "grace", email: "grace@fleet.test", password: PASSWORD });

    expect(auth.setEmail("ada", "ada.lovelace@fleet.test").email).toBe("ada.lovelace@fleet.test");
    expect(auth.getUser("ada")?.email).toBe("ada.lovelace@fleet.test");
    expect(db.findUserByEmail("ADA.LOVELACE@FLEET.TEST")?.username).toBe("ada");

    expect(() => auth.setEmail("ada", "GRACE@fleet.test")).toThrow(EmailAlreadyExistsError);
    expect(() => auth.setEmail("ada", "nonsense")).toThrow();
    expect(() => auth.setEmail("ghost", "ghost@fleet.test")).toThrow(UserNotFoundError);
    expect(auth.getUser("ada")?.email).toBe("ada.lovelace@fleet.test");

    expect(auth.setEmail("ada", "ADA.LOVELACE@fleet.test").email).toBe("ADA.LOVELACE@fleet.test");
  });

  test("login succeeds and both failure modes report the same error", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD, role: "admin" });

    const { token, user } = await auth.login("ada", PASSWORD);
    expect(token.length).toBeGreaterThan(0);
    expect(user).toMatchObject({ username: "ada", email: "ada@fleet.test", role: "admin", createdAt: clock });
    expect(auth.listUsers()).toEqual([user]);
    expect(auth.getUser("ada")).toEqual(user);

    const wrongPassword = await auth.login("ada", "not-the-password").catch((error: unknown) => error);
    const missingUser = await auth.login("ghost", PASSWORD).catch((error: unknown) => error);
    expect(wrongPassword).toBeInstanceOf(InvalidCredentialsError);
    expect(missingUser).toBeInstanceOf(InvalidCredentialsError);
    expect((missingUser as Error).message).toBe((wrongPassword as Error).message);
  });

  test("the plaintext session token is never stored", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    const { token } = await auth.login("ada", PASSWORD);

    expect(db.findSession(token)).toBeUndefined();
    const row = db.findSession(sha256(token));
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test("a session authenticates until it expires, then is cleaned up", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    const { token } = await auth.login("ada", PASSWORD);
    const hash = sha256(token);

    clock += SESSION_TTL_MS - 1;
    expect(auth.authenticate(`Bearer ${token}`)?.kind).toBe("user");
    expect(db.findSession(hash)?.last_used_at).toBe(clock);

    clock += 1;
    expect(auth.authenticate(`Bearer ${token}`)).toBeNull();
    expect(db.findSession(hash)).toBeUndefined();
  });

  test("last_used_at is refreshed at most once per touch interval", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    const { token } = await auth.login("ada", PASSWORD);
    const hash = sha256(token);
    const loginAt = clock;

    clock += SESSION_TOUCH_INTERVAL_MS - 1;
    expect(auth.authenticate(`Bearer ${token}`)?.kind).toBe("user");
    expect(db.findSession(hash)?.last_used_at).toBe(loginAt);

    clock += 1;
    expect(auth.authenticate(`Bearer ${token}`)?.kind).toBe("user");
    const touchedAt = clock;
    expect(db.findSession(hash)?.last_used_at).toBe(touchedAt);

    clock += 1;
    expect(auth.authenticate(`Bearer ${token}`)?.kind).toBe("user");
    expect(db.findSession(hash)?.last_used_at).toBe(touchedAt);
  });

  test("logout and setPassword revoke sessions", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    const first = await auth.login("ada", PASSWORD);
    auth.logout(first.token);
    expect(auth.authenticate(`Bearer ${first.token}`)).toBeNull();
    auth.logout(first.token);

    const second = await auth.login("ada", PASSWORD);
    expect(auth.authenticate(`Bearer ${second.token}`)).not.toBeNull();
    await auth.setPassword("ada", "a-brand-new-password");
    expect(auth.authenticate(`Bearer ${second.token}`)).toBeNull();
    expect(db.findSession(sha256(second.token))).toBeUndefined();

    await expect(auth.login("ada", PASSWORD)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect((await auth.login("ada", "a-brand-new-password")).token.length).toBeGreaterThan(0);
  });

  test("the last admin cannot be deleted or demoted", async () => {
    await auth.createFirstAdmin({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    await auth.createUser({ username: "grace", email: "grace@fleet.test", password: PASSWORD });

    expect(() => auth.deleteUser("ada")).toThrow(LastAdminError);
    expect(() => auth.setRole("ada", "member")).toThrow(LastAdminError);
    expect(() => auth.deleteUser("ghost")).toThrow(UserNotFoundError);
    expect(() => auth.setRole("ghost", "admin")).toThrow(UserNotFoundError);

    expect(auth.setRole("grace", "admin").role).toBe("admin");
    expect(auth.setRole("ada", "member").role).toBe("member");
    auth.deleteUser("ada");
    expect(auth.listUsers().map((user) => user.username)).toEqual(["grace"]);
  });

  test("ws tickets are single-use and expire", () => {
    const principal: Principal = { kind: "ship", ship: "ship-a" };
    const { ticket, expiresAt } = auth.issueWsTicket(principal);
    expect(expiresAt).toBe(clock + WS_TICKET_TTL_MS);
    expect(auth.redeemWsTicket(ticket)).toEqual(principal);
    expect(auth.redeemWsTicket(ticket)).toBeNull();

    const stale = auth.issueWsTicket(principal).ticket;
    clock += WS_TICKET_TTL_MS;
    expect(auth.redeemWsTicket(stale)).toBeNull();
    expect(auth.redeemWsTicket("never-issued")).toBeNull();
  });

  test("session, ship, and ship-agent tokens resolve to distinct principals", async () => {
    const user = await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD, role: "admin" });
    const { token } = await auth.login("ada", PASSWORD);
    const { shipToken, bridgeToken } = auth.createShipCredentials("ship-a");
    const agentToken = auth.mintShipAgentToken("ship-a");

    expect(auth.authenticate(`Bearer ${token}`)).toEqual({
      kind: "user",
      id: user.id,
      username: "ada",
      role: "admin",
    });
    expect(auth.authenticate(`Bearer ${shipToken}`)).toEqual({ kind: "ship", ship: "ship-a" });
    expect(auth.authenticate(`Bearer ${agentToken}`)).toEqual({ kind: "ship-agent", ship: "ship-a" });
    expect(auth.authenticate(`Bearer ${bridgeToken}`)).toBeNull();
    expect(new Set([token, shipToken, agentToken, bridgeToken]).size).toBe(4);
  });

  test("ship credentials round-trip and can be replaced or removed", () => {
    auth.setShipCredentials("ship-a", { shipToken: "ship-secret", bridgeToken: "bridge-secret" });
    expect(auth.bridgeTokenFor("ship-a")).toBe("bridge-secret");
    expect(auth.authenticate("Bearer ship-secret")).toEqual({ kind: "ship", ship: "ship-a" });

    const rotated = auth.createShipCredentials("ship-a");
    expect(auth.authenticate("Bearer ship-secret")).toBeNull();
    expect(auth.authenticate(`Bearer ${rotated.shipToken}`)).toEqual({ kind: "ship", ship: "ship-a" });
    expect(db.findShipCredentials("ship-a")?.ship_token_hash).toBe(sha256(rotated.shipToken));

    auth.deleteShipCredentials("ship-a");
    expect(auth.bridgeTokenFor("ship-a")).toBeUndefined();
    expect(auth.authenticate(`Bearer ${rotated.shipToken}`)).toBeNull();
    expect(() => auth.mintShipAgentToken("ship-a")).toThrow();
  });

  test("authenticate ignores malformed authorization headers", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });
    const { token } = await auth.login("ada", PASSWORD);

    expect(auth.authenticate(`  bEaReR   ${token}  `)?.kind).toBe("user");
    for (const header of [undefined, null, "", "   ", token, `Basic ${token}`, `Bearer`, `Bearer ${token} extra`, "!!"]) {
      expect(auth.authenticate(header)).toBeNull();
    }
  });
});
