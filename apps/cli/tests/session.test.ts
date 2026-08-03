import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, sessionFile, writeSession } from "fleet-cli-kit";
import { BridgeSession, SessionError, type SessionDeps } from "../src/session";

const FRESH_TOKEN = "fresh-token";
const USER = { id: "u1", username: "admin", email: "admin@example.com", role: "admin", createdAt: 0 };

describe("BridgeSession", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: { method: string; path: string; authorization: string | null }[];
  let authRequired: boolean;
  let accepts: (authorization: string | null) => boolean;
  let state: string;
  let env: Record<string, string | undefined>;
  let prompts: string[];

  beforeEach(async () => {
    requests = [];
    authRequired = true;
    accepts = (authorization) => authorization === `Bearer ${FRESH_TOKEN}`;
    prompts = [];
    state = await mkdtemp(join(tmpdir(), "fleet-cli-session-"));
    env = { XDG_STATE_HOME: state };

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization");
        requests.push({ method: request.method, path: url.pathname, authorization });

        if (url.pathname === "/auth/mode") return Response.json({ authRequired });
        if (url.pathname === "/auth/login") return Response.json({ token: FRESH_TOKEN, user: USER });
        if (!accepts(authorization)) {
          return Response.json({ error: "authentication required" }, { status: 401 });
        }
        return Response.json([]);
      },
    });
  });

  afterEach(async () => {
    server.stop(true);
    await rm(state, { recursive: true, force: true });
  });

  const bridgeUrl = () => `http://localhost:${server.port}`;

  function session(overrides: SessionDeps = {}): BridgeSession {
    return new BridgeSession(bridgeUrl(), {
      env,
      isTty: true,
      warn: () => {},
      promptLine: async () => {
        prompts.push("username");
        return "admin";
      },
      promptSecret: async () => {
        prompts.push("password");
        return "hunter2";
      },
      ...overrides,
    });
  }

  const shipRequests = () => requests.filter((request) => request.path === "/ships");

  test("a rejected stored session is replaced and the call replayed exactly once", async () => {
    await writeSession(bridgeUrl(), { token: "stale-token", username: "admin" }, { env });

    const result = await session().call((api) => api.ships.get());

    expect(result.error).toBeNull();
    expect(shipRequests()).toEqual([
      { method: "GET", path: "/ships", authorization: "Bearer stale-token" },
      { method: "GET", path: "/ships", authorization: `Bearer ${FRESH_TOKEN}` },
    ]);
    expect(prompts).toEqual(["username", "password"]);
    expect(await readSession(bridgeUrl(), { env })).toEqual({ token: FRESH_TOKEN, username: "admin" });
  });

  test("a bridge that keeps answering 401 is not retried a second time", async () => {
    await writeSession(bridgeUrl(), { token: "stale-token", username: "admin" }, { env });
    accepts = () => false;

    const result = await session().call((api) => api.ships.get());

    expect(result.error?.status).toBe(401);
    expect(shipRequests()).toHaveLength(2);
    expect(prompts).toEqual(["username", "password"]);
  });

  test("a 401 from a bridge that wants no auth clears the stale session without prompting", async () => {
    await writeSession(bridgeUrl(), { token: "stale-token", username: "admin" }, { env });
    authRequired = false;
    accepts = () => false;

    const result = await session().call((api) => api.ships.get());

    expect(result.error?.status).toBe(401);
    expect(shipRequests()).toHaveLength(1);
    expect(prompts).toEqual([]);
    expect(await readSession(bridgeUrl(), { env })).toBeNull();
  });

  test("no session and no terminal fails with instructions instead of blocking", async () => {
    const attempt = session({ isTty: false }).call((api) => api.ships.get());

    await expect(attempt).rejects.toBeInstanceOf(SessionError);
    await expect(attempt).rejects.toThrow("fleet login");
    expect(prompts).toEqual([]);
  });

  test("no session against a bridge that wants no auth neither prompts nor stores anything", async () => {
    authRequired = false;
    accepts = () => true;

    const result = await session({ isTty: false }).call((api) => api.ships.get());

    expect(result.error).toBeNull();
    expect(shipRequests()).toEqual([{ method: "GET", path: "/ships", authorization: null }]);
    expect(await Bun.file(sessionFile(bridgeUrl(), { env })).exists()).toBe(false);
  });

  test("FLEET_TOKEN authenticates without a prompt and is not written to disk", async () => {
    const result = await session({
      env: { ...env, FLEET_TOKEN: FRESH_TOKEN },
      isTty: false,
    }).call((api) => api.ships.get());

    expect(result.error).toBeNull();
    expect(shipRequests()).toEqual([
      { method: "GET", path: "/ships", authorization: `Bearer ${FRESH_TOKEN}` },
    ]);
    expect(await Bun.file(sessionFile(bridgeUrl(), { env })).exists()).toBe(false);
  });

  test("a stored session that works is used as-is, without asking the bridge its mode", async () => {
    await writeSession(bridgeUrl(), { token: FRESH_TOKEN, username: "admin" }, { env });

    const result = await session({ isTty: false }).call((api) => api.ships.get());

    expect(result.error).toBeNull();
    expect(requests.map((request) => request.path)).toEqual(["/ships"]);
  });

  test("logIn stores the session it is handed", async () => {
    const stored = await session().logIn("admin");

    expect(stored).toEqual({ token: FRESH_TOKEN, username: "admin" });
    expect(prompts).toEqual(["password"]);
    expect(await readSession(bridgeUrl(), { env })).toEqual(stored);
  });

  test("logOut deletes the local session even when the bridge refuses to revoke it", async () => {
    await writeSession(bridgeUrl(), { token: "stale-token", username: "admin" }, { env });
    const warnings: string[] = [];

    await session({ warn: (text) => void warnings.push(text) }).logOut();

    expect(await readSession(bridgeUrl(), { env })).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test("currentUser drops a session the bridge no longer knows", async () => {
    await writeSession(bridgeUrl(), { token: "stale-token", username: "admin" }, { env });

    expect(await session().currentUser()).toBeNull();
    expect(await readSession(bridgeUrl(), { env })).toBeNull();
  });
});
