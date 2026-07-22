/**
 * auth.test.ts — drives the auth routes in-process via `app.handle(Request)`,
 * asserting the status codes, bodies, and Set-Cookie / session behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { AuthService } from "../src/auth-service";
import { Store } from "../src/store/store";
import { authPlugin } from "../src/api/auth";
import { SESSION_COOKIE } from "../src/api/cookies";

/** Pull the session token out of a response's Set-Cookie header. */
function cookieToken(res: Response): string | undefined {
  const header = res.headers.get("set-cookie");
  if (!header) return undefined;
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  const value = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  return value ? value : undefined;
}

function makeAuthApp(auth: AuthService) {
  return new Elysia().use(authPlugin(auth, { sessionTtlMs: 60_000, secure: false }));
}

describe("auth routes", () => {
  let dir: string;
  let app: ReturnType<typeof makeAuthApp>;
  let auth: AuthService;

  async function call(method: string, path: string, body?: unknown, cookie?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers["cookie"] = `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
    const res = await app.handle(
      new Request(`http://bridge${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-auth-routes-"));
    const store = new Store(dir);
    await store.load();
    auth = new AuthService(store, { sessionTtlMs: 60_000 });
    app = makeAuthApp(auth);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("bootstrap creates the first user, then 409s", async () => {
    const first = await call("POST", "/auth/bootstrap", { username: "admin", password: "pw" });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ username: "admin" });
    expect(cookieToken(first.res)).toBeTruthy();

    const second = await call("POST", "/auth/bootstrap", { username: "other", password: "pw" });
    expect(second.status).toBe(409);
  });

  test("login sets a cookie, wrong password 401s, missing fields 422", async () => {
    await auth.createUser("admin", "pw");

    const ok = await call("POST", "/auth/login", { username: "admin", password: "pw" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ username: "admin" });
    expect(cookieToken(ok.res)).toBeTruthy();

    expect((await call("POST", "/auth/login", { username: "admin", password: "nope" })).status).toBe(401);
    expect((await call("POST", "/auth/login", { username: "admin" })).status).toBe(422);
  });

  test("whoami reflects the session cookie", async () => {
    await auth.createUser("admin", "pw");
    const login = await call("POST", "/auth/login", { username: "admin", password: "pw" });
    const token = cookieToken(login.res)!;

    expect((await call("GET", "/auth/whoami")).status).toBe(401);
    const who = await call("GET", "/auth/whoami", undefined, token);
    expect(who.status).toBe(200);
    expect(who.body).toEqual({ username: "admin" });
  });

  test("logout revokes the session", async () => {
    await auth.createUser("admin", "pw");
    const login = await call("POST", "/auth/login", { username: "admin", password: "pw" });
    const token = cookieToken(login.res)!;

    expect((await call("POST", "/auth/logout", undefined, token)).status).toBe(200);
    expect((await call("GET", "/auth/whoami", undefined, token)).status).toBe(401);
  });

  test("ws-ticket requires a session and issues a ticket", async () => {
    await auth.createUser("admin", "pw");
    const login = await call("POST", "/auth/login", { username: "admin", password: "pw" });
    const token = cookieToken(login.res)!;

    expect((await call("GET", "/auth/ws-ticket")).status).toBe(401);
    const ticket = await call("GET", "/auth/ws-ticket", undefined, token);
    expect(ticket.status).toBe(200);
    expect(typeof ticket.body.ticket).toBe("string");
    expect(auth.consumeTicket(ticket.body.ticket)).toBeTruthy();
  });
});
