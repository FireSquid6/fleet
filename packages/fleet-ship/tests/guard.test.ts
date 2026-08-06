import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/api";
import { stubConfig, stubManager } from "./helpers";

const BRIDGE_TOKEN = "bridge-secret";
const AGENT_TOKEN = "agent-secret";

const servers: { stop(closeActiveConnections?: boolean): unknown }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function makeApp(config: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return createApp(stubManager(), { ...stubConfig, ...config }, undefined, undefined, undefined, env);
}

function get(app: ReturnType<typeof createApp>, token?: string): Promise<Response> {
  return app.handle(
    new Request("http://ship/workspaces", {
      headers: token === undefined ? undefined : { authorization: token },
    }),
  );
}

function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.handle(
    new Request(`http://ship${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const opened = (socket: WebSocket) =>
  new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true), { once: true });
    socket.addEventListener("error", () => resolve(false), { once: true });
  });

describe("ship guard", () => {
  test("serves openly when no bridgeToken is configured", async () => {
    const app = makeApp();

    expect((await get(app)).status).toBe(200);
    expect((await get(app, "Bearer anything")).status).toBe(200);
  });

  test("accepts the configured bridgeToken", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN });

    const response = await get(app, `Bearer ${BRIDGE_TOKEN}`);
    expect(response.status).toBe(200);
  });

  test("rejects a wrong, malformed or missing credential with 401", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN });

    for (const header of [undefined, "", "Bearer wrong", "Bearer ", BRIDGE_TOKEN, `Basic ${BRIDGE_TOKEN}`]) {
      const response = await get(app, header);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "authentication required" });
    }
  });

  test("accepts the bearer scheme in any case", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN });

    expect((await get(app, `bearer ${BRIDGE_TOKEN}`)).status).toBe(200);
  });

  test("falls back to the environment when the config carries no bridgeToken", async () => {
    const app = makeApp({}, { FLEET_BRIDGE_TOKEN: BRIDGE_TOKEN });

    expect((await get(app)).status).toBe(401);
    expect((await get(app, `Bearer ${BRIDGE_TOKEN}`)).status).toBe(200);
  });

  test("prefers the configured bridgeToken over the environment", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN }, { FLEET_BRIDGE_TOKEN: "stale" });

    expect((await get(app, "Bearer stale")).status).toBe(401);
    expect((await get(app, `Bearer ${BRIDGE_TOKEN}`)).status).toBe(200);
  });

  test("an agent token stays inert while the ship serves openly", async () => {
    const app = makeApp({ agentToken: AGENT_TOKEN });

    expect((await get(app)).status).toBe(200);
    expect((await request(app, "DELETE", "/workspaces/r/n")).status).toBe(200);
  });

  test("an agent token is not a bridge token", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN, agentToken: AGENT_TOKEN });

    expect((await get(app, `Bearer ${AGENT_TOKEN}`)).status).toBe(403);
    expect((await get(app, `Bearer ${BRIDGE_TOKEN}`)).status).toBe(200);
    expect((await get(app, "Bearer neither")).status).toBe(401);
  });

  test("an agent reaches its own workspace routes", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN, agentToken: AGENT_TOKEN });

    expect((await request(app, "GET", "/workspaces/r/n/agent/status", AGENT_TOKEN)).status).toBe(200);
    expect(
      (await request(app, "POST", "/workspaces/r/n/agent/status", AGENT_TOKEN, {
        state: "idle",
        description: "d",
      })).status,
    ).toBe(200);
    expect(
      (await request(app, "POST", "/workspaces/r/n/agent/init", AGENT_TOKEN, {
        model: "m",
        provider: "p",
        harness: "h",
      })).status,
    ).toBe(200);
    expect((await request(app, "GET", "/agent/credentials", AGENT_TOKEN)).status).toBe(503);
  });

  test("an agent is refused every other route with 403", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN, agentToken: AGENT_TOKEN });
    const forbidden: [string, string, unknown?][] = [
      ["GET", "/workspaces"],
      ["POST", "/workspaces", { url: "u", repoName: "r", name: "n", branch: "main" }],
      ["GET", "/workspaces/r/n"],
      ["GET", "/workspaces/r/n/diff"],
      ["DELETE", "/workspaces/r/n"],
      ["POST", "/workspaces/r/n/activate"],
      ["POST", "/workspaces/r/n/deactivate"],
      ["POST", "/workspaces/r/n/branch", { branch: "main" }],
      ["DELETE", "/workspaces/r/n/agent/status"],
      ["GET", "/system-resources"],
      ["GET", "/armory"],
      ["POST", "/armory/sync", { bridgeUrl: "http://bridge", revision: "r" }],
      ["POST", "/agent/credentials", { bridgeUrl: "http://bridge", token: "t" }],
    ];

    for (const [method, path, body] of forbidden) {
      const response = await request(app, method, path, AGENT_TOKEN, body);
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
      expect(await response.json()).toEqual({ error: `this agent credential may not reach ${method} ${path}` });
    }
  });

  test("an agent cannot open a terminal or the events socket", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN, agentToken: AGENT_TOKEN });
    app.listen(0);
    if (app.server) servers.push(app.server);
    const base = `ws://localhost:${app.server?.port}`;
    const headers = { authorization: `Bearer ${AGENT_TOKEN}` };

    expect(await opened(new WebSocket(`${base}/events`, { headers }))).toBe(false);
    expect(await opened(new WebSocket(`${base}/workspaces/r/n/terminal`, { headers }))).toBe(false);
  });

  test("guards the events socket too", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN });
    app.listen(0);
    if (app.server) servers.push(app.server);
    const url = `ws://localhost:${app.server?.port}/events`;

    expect(await opened(new WebSocket(url))).toBe(false);
    expect(await opened(new WebSocket(url, { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } }))).toBe(true);
  });
});
