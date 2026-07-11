/**
 * api.test.ts — drives the bridge's composed Elysia app in-process via
 * `app.handle(Request)` (no port) over a real FleetManager + fake ships, asserting
 * the HTTP status codes and bodies the routes actually return.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { getDb } from "../src/db";
import { ShipService } from "../src/services/ship-service";
import { FakeSocket, makeDeps, ws, type FakeShip } from "./helpers";

describe("bridge API", () => {
  let dir: string;
  let manager: FleetManager;
  let app: ReturnType<typeof createApp>;
  let ships: Map<string, FakeShip>;

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.handle(
      new Request(`http://bridge${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-api-"));
    FakeSocket.byBase.clear();
    ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one", true)] }],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo2", "two")] }],
      ["http://ship-c", { name: "ship-c", workspaces: [] }], // reachable, not yet added
    ]);
    const config = { dataDirectory: dir, port: 4800, name: "bridge", ephemeralDb: true };
    const db = getDb(config);
    const seed = new ShipService(db);
    await seed.createShip({ name: "ship-a", url: "http://ship-a" });
    await seed.createShip({ name: "ship-b", url: "http://ship-b" });
    manager = new FleetManager(config, makeDeps(ships), { syncTimeoutMs: 50, db });
    await manager.init();
    app = createApp(manager, config);
  });
  afterEach(async () => {
    manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  test("GET /ships lists ships with status", async () => {
    const { status, body } = await call("GET", "/ships");
    expect(status).toBe(200);
    expect(body.map((s: { name: string }) => s.name).sort()).toEqual(["ship-a", "ship-b"]);
  });

  test("POST /ships adds (201), rejects duplicate name (409) and unreachable (502)", async () => {
    expect((await call("POST", "/ships", { url: "http://ship-c" })).status).toBe(201);
    expect((await call("POST", "/ships", { url: "http://ship-a" })).status).toBe(409);
    expect((await call("POST", "/ships", { url: "http://ship-missing" })).status).toBe(502);
  });

  test("POST /ships validates the body (422)", async () => {
    expect((await call("POST", "/ships", {})).status).toBe(422);
  });

  test("DELETE /ships/:name removes (200) or 404s", async () => {
    expect((await call("DELETE", "/ships/ship-b")).status).toBe(200);
    expect((await call("DELETE", "/ships/ship-b")).status).toBe(404);
  });

  test("GET /workspaces merges + filters", async () => {
    expect((await call("GET", "/workspaces")).body).toHaveLength(2);
    expect((await call("GET", "/workspaces?active=true")).body).toHaveLength(1);
    expect((await call("GET", "/workspaces?active=false")).body).toHaveLength(1);
  });

  test("GET /workspaces/:repo/:name proxies (200) or 404s", async () => {
    const ok = await call("GET", "/workspaces/repo1/one");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ repo: "repo1", name: "one", ship: "ship-a" });
    expect((await call("GET", "/workspaces/nope/gone")).status).toBe(404);
  });

  test("POST /workspaces: 201 create, 400 unknown ship, 409 duplicate, 422 invalid", async () => {
    const created = await call("POST", "/workspaces", {
      repo: "repo3",
      name: "three",
      branch: "main",
      ship: "ship-a",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ repo: "repo3", name: "three", ship: "ship-a" });

    expect(
      (await call("POST", "/workspaces", { repo: "r", name: "n", branch: "main", ship: "ghost" })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/workspaces", { repo: "repo1", name: "one", branch: "main", ship: "ship-a" })).status,
    ).toBe(409);
    expect((await call("POST", "/workspaces", { repo: "r", name: "n", branch: "main" })).status).toBe(422);
  });

  test("verb routes return { ok: true }", async () => {
    expect(await call("POST", "/workspaces/repo1/one/deactivate")).toEqual({ status: 200, body: { ok: true } });
    expect(await call("POST", "/workspaces/repo1/one/branch", { branch: "dev" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await call("DELETE", "/workspaces/repo2/two")).toEqual({ status: 200, body: { ok: true } });
  });

  test("GET /system-resources aggregates; per-ship 200/400/503", async () => {
    const agg = await call("GET", "/system-resources");
    expect(agg.status).toBe(200);
    expect(agg.body.map((r: { ship: string }) => r.ship).sort()).toEqual(["ship-a", "ship-b"]);

    expect((await call("GET", "/ships/ship-a/system-resources")).status).toBe(200);
    expect((await call("GET", "/ships/ghost/system-resources")).status).toBe(400);

    ships.delete("http://ship-b");
    FakeSocket.byBase.get("http://ship-b")?.close();
    expect((await call("GET", "/ships/ship-b/system-resources")).status).toBe(503);
  });

  test("GET /repos merges; per-ship 200/400/503", async () => {
    const agg = await call("GET", "/repos");
    expect(agg.status).toBe(200);
    expect(agg.body.map((r: { repo: string }) => r.repo).sort()).toEqual(["repo1", "repo2"]);

    const perShip = await call("GET", "/ships/ship-a/repos");
    expect(perShip.status).toBe(200);
    expect(perShip.body).toEqual([{ repo: "repo1", remote: "git@fake/repo1.git", workspaces: 1 }]);

    expect((await call("GET", "/ships/ghost/repos")).status).toBe(400);

    ships.delete("http://ship-b");
    FakeSocket.byBase.get("http://ship-b")?.close();
    expect((await call("GET", "/ships/ship-b/repos")).status).toBe(503);
  });
});
