import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/api";
import { stubConfig, stubManager } from "./helpers";

const BRIDGE_TOKEN = "bridge-secret";

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

  test("guards the events socket too", async () => {
    const app = makeApp({ bridgeToken: BRIDGE_TOKEN });
    app.listen(0);
    if (app.server) servers.push(app.server);
    const url = `ws://localhost:${app.server?.port}/events`;

    expect(await opened(new WebSocket(url))).toBe(false);
    expect(await opened(new WebSocket(url, { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } }))).toBe(true);
  });
});
