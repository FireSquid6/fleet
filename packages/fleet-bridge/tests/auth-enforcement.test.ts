import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { AuthDatabase } from "../src/auth/auth-database";
import { AuthService, type Principal } from "../src/auth/auth-service";
import { FleetManager } from "../src/fleet-manager";
import { makeAuthedApp, makeDeps, makeTestAuth, seedUser, type FakeShip } from "./helpers";

const PUBLIC = new Set(["POST /auth/login", "GET /auth/mode", "POST /auth/logout"]);

const SAMPLES: Record<string, string> = {
  ":repo": "repo1",
  ":name": "one",
  ":ship": "ship-a",
  ":number": "1",
};

function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => SAMPLES[segment] ?? segment)
    .join("/");
}

const opened = (sock: WebSocket) =>
  new Promise<boolean>((resolve) => {
    sock.addEventListener("open", () => resolve(true), { once: true });
    sock.addEventListener("error", () => resolve(false), { once: true });
  });

describe("bridge default-deny enforcement", () => {
  let dir: string;
  let manager: FleetManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-enforce-"));
    manager = new FleetManager({ dataDirectory: dir, port: 4800, name: "bridge" }, makeDeps(new Map<string, FakeShip>()), {
      syncTimeoutMs: 50,
    });
    await manager.init();
  });

  afterEach(async () => {
    manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  async function status(
    app: ReturnType<typeof createApp>,
    method: string,
    path: string,
    init: RequestInit = {},
  ): Promise<number> {
    const response = await app.handle(new Request(`http://bridge${path}`, { method, ...init }));
    return response.status;
  }

  test("every route rejects an anonymous caller", async () => {
    const { app } = await makeAuthedApp(manager);

    const answered: string[] = [];
    for (const route of app.routes) {
      const name = `${route.method} ${route.path}`;
      if (PUBLIC.has(name)) continue;
      const method = route.method === "WS" ? "GET" : route.method;
      if ((await status(app, method, concretePath(route.path))) !== 401) answered.push(name);
    }

    expect(answered).toEqual([]);
    expect(app.routes.length).toBeGreaterThan(30);
  });

  test("the public routes answer without credentials", async () => {
    const { app } = await makeAuthedApp(manager);

    expect(await status(app, "GET", "/auth/mode")).toBe(200);
    expect(await status(app, "POST", "/auth/logout")).toBe(200);
    expect(
      await status(app, "POST", "/auth/login", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "nobody", password: "wrong-password" }),
      }),
    ).toBe(401);
  });

  test("the armory routes answer a ship or a user credential and nothing else", async () => {
    const { app, auth, authorization } = await makeAuthedApp(manager);
    const { shipToken } = auth.createShipCredentials("ship-a");
    const asShip = { headers: { authorization: `Bearer ${shipToken}` } };
    const asUser = { headers: { authorization } };

    expect(await status(app, "GET", "/armory")).toBe(401);
    expect(await status(app, "GET", "/armory/file?path=nope")).toBe(401);

    expect(await status(app, "GET", "/armory", asShip)).toBe(200);
    expect(await status(app, "GET", "/armory/file?path=nope", asShip)).toBe(404);
    expect(await status(app, "GET", "/armory", asUser)).toBe(200);
    expect(await status(app, "GET", "/armory/file?path=nope", asUser)).toBe(404);
  });

  test("insecureNoAuth serves every route without credentials", async () => {
    const { app } = await makeAuthedApp(manager, { insecureNoAuth: true });

    expect(await status(app, "GET", "/ships")).toBe(200);
    expect(await status(app, "GET", "/workspaces")).toBe(200);
    expect(await status(app, "GET", "/repos")).toBe(200);
    expect(await status(app, "GET", "/users")).toBe(200);
    expect(await status(app, "GET", "/auth/mode")).toBe(200);
  });

  describe("principal narrowing", () => {
    let auth: AuthService;
    let app: ReturnType<typeof createApp>;

    async function tokenFor(kind: "ship" | "ship-agent"): Promise<string> {
      const { shipToken } = auth.createShipCredentials("ship-a");
      return kind === "ship" ? shipToken : auth.mintShipAgentToken("ship-a");
    }

    beforeEach(() => {
      auth = makeTestAuth();
      app = createApp(manager, auth);
    });

    const withToken = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

    test("a ship principal reaches the armory and nothing else", async () => {
      const token = await tokenFor("ship");

      expect(await status(app, "GET", "/ships", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/workspaces", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/repos", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/armory/ships", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/users", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/armory", withToken(token))).toBe(200);
      expect(await status(app, "GET", "/armory/file?path=nope", withToken(token))).toBe(404);
    });

    test("a ship-agent principal reaches the repo routes and nothing else", async () => {
      const token = await tokenFor("ship-agent");

      expect(await status(app, "GET", "/ships", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/workspaces", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/users", withToken(token))).toBe(403);
      expect(await status(app, "GET", "/repos", withToken(token))).toBe(200);
      expect(await status(app, "GET", "/repos/ghost/info", withToken(token))).toBe(404);
    });

    test("a user principal reaches everything the handlers allow", async () => {
      const { token } = await seedUser(auth, { username: "ada" });

      expect(await status(app, "GET", "/ships", withToken(token))).toBe(200);
      expect(await status(app, "GET", "/workspaces", withToken(token))).toBe(200);
      expect(await status(app, "GET", "/repos", withToken(token))).toBe(200);
      expect(await status(app, "GET", "/users", withToken(token))).toBe(403);
    });
  });

  describe("WebSocket tickets", () => {
    let auth: AuthService;
    let app: ReturnType<typeof createApp>;
    let base: string;
    let principal: Principal;

    beforeEach(async () => {
      const authed = await makeAuthedApp(manager);
      auth = authed.auth;
      app = authed.app;
      app.listen(0);
      base = `ws://localhost:${app.server?.port}`;
      principal = { kind: "user", id: "t", username: "test-admin", role: "admin" };
    });

    afterEach(() => {
      app.server?.stop(true);
    });

    for (const path of ["/events", "/workspaces/repo1/one/terminal"]) {
      test(`${path} accepts a fresh ticket and refuses anything else`, async () => {
        expect(await opened(new WebSocket(`${base}${path}`))).toBe(false);

        const { ticket } = auth.issueWsTicket(principal);
        expect(await opened(new WebSocket(`${base}${path}?ticket=${ticket}`))).toBe(true);
        expect(await opened(new WebSocket(`${base}${path}?ticket=${ticket}`))).toBe(false);

        expect(await opened(new WebSocket(`${base}${path}?ticket=never-issued`))).toBe(false);
      });
    }

    test("an expired ticket is refused", async () => {
      const clock = { now: Date.now() };
      const database = new AuthDatabase(":memory:");
      database.migrate();
      const expiring = new AuthService(database, { now: () => clock.now });
      const expiringApp = createApp(manager, expiring);
      expiringApp.listen(0);
      const url = `ws://localhost:${expiringApp.server?.port}/events`;

      const { ticket, expiresAt } = expiring.issueWsTicket(principal);
      clock.now = expiresAt + 1;

      expect(await opened(new WebSocket(`${url}?ticket=${ticket}`))).toBe(false);
      expiringApp.server?.stop(true);
    });

    test("a ticket in an ordinary request neither authenticates it nor burns it", async () => {
      const { ticket } = auth.issueWsTicket(principal);

      expect(await status(app, "GET", `/ships?ticket=${ticket}`)).toBe(401);

      expect(await opened(new WebSocket(`${base}/events?ticket=${ticket}`))).toBe(true);
    });
  });
});
