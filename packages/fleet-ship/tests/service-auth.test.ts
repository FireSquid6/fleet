/**
 * service-auth.test.ts — the ship's shared-service-token guard.
 *
 * With a token configured, every route (HTTP and the WS upgrades) demands a
 * matching `Authorization: Bearer`; with none configured the ship stays open
 * (rollout compatibility).
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api";
import { stubConfig, stubManager } from "./helpers";

const TOKEN = "s3rvice-t0ken";

function request(path: string, token?: string, upgrade = false) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (upgrade) {
    headers.upgrade = "websocket";
    headers.connection = "upgrade";
    headers["sec-websocket-key"] = "dGhlIHNhbXBsZSBub25jZQ==";
    headers["sec-websocket-version"] = "13";
  }
  return new Request(`http://ship${path}`, { headers });
}

describe("ship service-token guard", () => {
  test("with a token: rejects missing/wrong, accepts correct", async () => {
    const app = createApp(stubManager(), { ...stubConfig, serviceToken: TOKEN });

    expect((await app.handle(request("/workspaces"))).status).toBe(401);
    expect((await app.handle(request("/workspaces", "nope"))).status).toBe(401);
    expect((await app.handle(request("/workspaces", TOKEN))).status).toBe(200);
  });

  test("with a token: guards the events WS upgrade", async () => {
    const app = createApp(stubManager(), { ...stubConfig, serviceToken: TOKEN });

    expect((await app.handle(request("/events", undefined, true))).status).toBe(401);
    // A correct token lets the upgrade proceed (i.e. it is not rejected with 401).
    expect((await app.handle(request("/events", TOKEN, true))).status).not.toBe(401);
  });

  test("without a token: the ship stays open", async () => {
    const app = createApp(stubManager(), stubConfig);
    expect((await app.handle(request("/workspaces"))).status).toBe(200);
    expect((await app.handle(request("/workspaces", "irrelevant"))).status).toBe(200);
  });
});
