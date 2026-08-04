import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import type { AuthService } from "../src/auth/auth-service";
import { FleetManager } from "../src/fleet-manager";
import { makeDeps, makeTestAuth, seedUser, TEST_PASSWORD, type FakeShip } from "./helpers";

describe("auth + users routes", () => {
  let dir: string;
  let manager: FleetManager;
  let auth: AuthService;
  let app: ReturnType<typeof createApp>;

  async function call(method: string, path: string, options?: { body?: unknown; token?: string }) {
    const headers: Record<string, string> = {};
    if (options?.body !== undefined) headers["content-type"] = "application/json";
    if (options?.token) headers.authorization = `Bearer ${options.token}`;
    const res = await app.handle(
      new Request(`http://bridge${path}`, {
        method,
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  const login = (username: string, password: string) =>
    call("POST", "/auth/login", { body: { username, password } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-auth-"));
    manager = new FleetManager(
      { dataDirectory: dir, port: 4800, name: "bridge" },
      makeDeps(new Map<string, FakeShip>()),
      { syncTimeoutMs: 50 },
    );
    await manager.init();
    auth = makeTestAuth();
    app = createApp(manager, auth);
  });

  afterEach(async () => {
    manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  test("existing routes now require credentials", async () => {
    expect((await call("GET", "/ships")).status).toBe(401);
    expect((await call("GET", "/workspaces")).status).toBe(401);

    const { token } = await seedUser(auth, { username: "ada" });
    expect((await call("GET", "/ships", { token })).status).toBe(200);
    expect((await call("GET", "/workspaces", { token })).status).toBe(200);
  });

  test("GET /auth/mode reports whether credentials are wanted, without needing any", async () => {
    expect(await call("GET", "/auth/mode")).toEqual({ status: 200, body: { authRequired: true } });

    app = createApp(manager, auth, { insecureNoAuth: true });
    expect(await call("GET", "/auth/mode")).toEqual({ status: 200, body: { authRequired: false } });
  });

  test("POST /auth/login returns a token, and fails identically for both wrong inputs", async () => {
    await seedUser(auth, { username: "ada" });

    const ok = await login("ada", TEST_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeString();
    expect(ok.body.user).toMatchObject({ username: "ada", role: "member" });
    expect(ok.body.user.password_hash).toBeUndefined();

    const wrongPassword = await login("ada", "not-the-password");
    const unknownUser = await login("nobody", TEST_PASSWORD);
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body).toEqual(wrongPassword.body);
  });

  test("GET /auth/me needs a valid bearer token", async () => {
    const { token, user } = await seedUser(auth, { username: "ada" });

    expect((await call("GET", "/auth/me")).status).toBe(401);
    expect((await call("GET", "/auth/me", { token: "made-up" })).status).toBe(401);

    const me = await call("GET", "/auth/me", { token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual(user);
  });

  test("POST /auth/logout revokes the calling token, and is a no-op without one", async () => {
    const { token } = await seedUser(auth, { username: "ada" });

    expect(await call("POST", "/auth/logout")).toEqual({ status: 200, body: { ok: true } });
    expect((await call("POST", "/auth/logout", { token })).body).toEqual({ ok: true });
    expect((await call("GET", "/auth/me", { token })).status).toBe(401);
    expect((await call("POST", "/auth/logout", { token })).body).toEqual({ ok: true });
  });

  test("POST /auth/ws-ticket issues a redeemable single-use ticket", async () => {
    const { token, user } = await seedUser(auth, { username: "ada" });

    expect((await call("POST", "/auth/ws-ticket")).status).toBe(401);
    const issued = await call("POST", "/auth/ws-ticket", { token });
    expect(issued.status).toBe(200);
    expect(issued.body.expiresAt).toBeGreaterThan(Date.now());

    expect(auth.redeemWsTicket(issued.body.ticket)).toEqual({
      kind: "user",
      id: user.id,
      username: "ada",
      role: "member",
    });
    expect(auth.redeemWsTicket(issued.body.ticket)).toBeNull();
  });

  test("an admin lists, creates and deletes users", async () => {
    const admin = await seedUser(auth, { username: "root", role: "admin" });

    const created = await call("POST", "/users", {
      token: admin.token,
      body: { username: "ada", email: "ada@fleet.test", password: TEST_PASSWORD },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ username: "ada", role: "member" });

    const duplicate = await call("POST", "/users", {
      token: admin.token,
      body: { username: "ada", email: "other@fleet.test", password: TEST_PASSWORD },
    });
    expect(duplicate.status).toBe(409);

    const list = await call("GET", "/users", { token: admin.token });
    expect(list.status).toBe(200);
    expect(list.body.map((u: { username: string }) => u.username)).toEqual(["root", "ada"]);

    const promoted = await call("POST", "/users/ada/role", { token: admin.token, body: { role: "admin" } });
    expect(promoted.body).toMatchObject({ username: "ada", role: "admin" });

    expect((await call("DELETE", "/users/ada", { token: admin.token })).body).toEqual({ ok: true });
    expect((await call("DELETE", "/users/ada", { token: admin.token })).status).toBe(404);
    expect(auth.listUsers()).toHaveLength(1);
  });

  test("values the service rejects are 400s that name the field, not 500s", async () => {
    const admin = await seedUser(auth, { username: "root", role: "admin" });

    const badEmail = await call("POST", "/users", {
      token: admin.token,
      body: { username: "ada", email: "not-an-email", password: TEST_PASSWORD },
    });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error).toContain("email");

    const shortPassword = await call("POST", "/users", {
      token: admin.token,
      body: { username: "ada", email: "ada@fleet.test", password: "short" },
    });
    expect(shortPassword.status).toBe(400);
    expect(shortPassword.body.error).toContain("password");

    const badUsername = await call("POST", "/users", {
      token: admin.token,
      body: { username: "ada/bob", email: "ada@fleet.test", password: TEST_PASSWORD },
    });
    expect(badUsername.status).toBe(400);
    expect(badUsername.body.error).toContain("username");

    await seedUser(auth, { username: "ada" });
    const rename = await call("POST", "/users/ada/email", {
      token: admin.token,
      body: { email: "still-not-an-email" },
    });
    expect(rename.status).toBe(400);
    expect(rename.body.error).toContain("email");
    expect(auth.getUser("ada")?.email).toBe("ada@fleet.test");
  });

  test("user routes reject unauthenticated callers", async () => {
    await seedUser(auth, { username: "root", role: "admin" });
    expect((await call("GET", "/users")).status).toBe(401);
    expect((await call("DELETE", "/users/root")).status).toBe(401);
  });

  test("a member is forbidden from admin-only routes", async () => {
    const admin = await seedUser(auth, { username: "root", role: "admin" });
    const member = await seedUser(auth, { username: "ada" });

    expect((await call("GET", "/users", { token: member.token })).status).toBe(403);
    expect(
      (
        await call("POST", "/users", {
          token: member.token,
          body: { username: "eve", email: "eve@fleet.test", password: TEST_PASSWORD },
        })
      ).status,
    ).toBe(403);
    expect((await call("DELETE", "/users/root", { token: member.token })).status).toBe(403);
    expect(
      (await call("POST", "/users/ada/role", { token: member.token, body: { role: "admin" } })).status,
    ).toBe(403);
    expect(auth.getUser("ada")?.role).toBe("member");
    expect((await call("GET", "/users", { token: admin.token })).status).toBe(200);
  });

  test("a member may change their own email and password, but nobody else's", async () => {
    await seedUser(auth, { username: "root", role: "admin" });
    const member = await seedUser(auth, { username: "ada" });

    const email = await call("POST", "/users/ada/email", {
      token: member.token,
      body: { email: "ada@example.test" },
    });
    expect(email.status).toBe(200);
    expect(auth.getUser("ada")?.email).toBe("ada@example.test");

    expect(
      (await call("POST", "/users/root/email", { token: member.token, body: { email: "hijack@fleet.test" } }))
        .status,
    ).toBe(403);
    expect(
      (await call("POST", "/users/root/password", { token: member.token, body: { password: "hijacked!" } }))
        .status,
    ).toBe(403);
    expect(
      (await call("POST", "/users/ghost/password", { token: member.token, body: { password: "hijacked!" } }))
        .status,
    ).toBe(403);
    expect(auth.getUser("root")?.email).toBe("root@fleet.test");

    const changed = await call("POST", "/users/ada/password", {
      token: member.token,
      body: { password: "brand-new-password" },
    });
    expect(changed.body).toEqual({ ok: true });
    expect((await login("ada", "brand-new-password")).status).toBe(200);
    expect((await login("ada", TEST_PASSWORD)).status).toBe(401);
    expect((await call("GET", "/auth/me", { token: member.token })).status).toBe(401);
  });

  test("an admin may reset another user's password", async () => {
    const admin = await seedUser(auth, { username: "root", role: "admin" });
    await seedUser(auth, { username: "ada" });

    const reset = await call("POST", "/users/ada/password", {
      token: admin.token,
      body: { password: "reset-by-the-admin" },
    });
    expect(reset.status).toBe(200);
    expect((await login("ada", "reset-by-the-admin")).status).toBe(200);
  });

  test("deleting or demoting the last admin is rejected", async () => {
    const admin = await seedUser(auth, { username: "root", role: "admin" });
    await seedUser(auth, { username: "ada" });

    expect((await call("DELETE", "/users/root", { token: admin.token })).status).toBe(409);
    expect(
      (await call("POST", "/users/root/role", { token: admin.token, body: { role: "member" } })).status,
    ).toBe(409);
    expect(auth.getUser("root")?.role).toBe("admin");
  });
});
