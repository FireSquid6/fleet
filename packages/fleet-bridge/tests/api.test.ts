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
import { Store } from "../src/store/store";
import { FakeSocket, makeDeps, ws, type FakeShip } from "./helpers";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  /** Read the raw response text — for the text/plain diff route. */
  async function callText(path: string) {
    const res = await app.handle(new Request(`http://bridge${path}`));
    return { status: res.status, text: await res.text() };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-api-"));
    FakeSocket.byBase.clear();
    ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one", true)] }],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo2", "two")] }],
      ["http://ship-c", { name: "ship-c", workspaces: [] }], // reachable, not yet added
    ]);
    const config = { dataDirectory: dir, port: 4800, name: "bridge" };
    const store = new Store(dir);
    await store.load();
    await store.createShip({ name: "ship-a", url: "http://ship-a" });
    await store.createShip({ name: "ship-b", url: "http://ship-b" });
    manager = new FleetManager(config, makeDeps(ships), { syncTimeoutMs: 50, store });
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

  test("GET /workspaces refreshes a branch changed without an event", async () => {
    const ship = ships.get("http://ship-a")!;
    ship.workspaces[0] = { ...ship.workspaces[0]!, branch: "feature" };

    const result = await call("GET", "/workspaces");
    expect(result.body.find((workspace: { name: string }) => workspace.name === "one")?.branch).toBe("feature");
  });

  test("GET /workspaces/:repo/:name proxies (200) or 404s", async () => {
    const ok = await call("GET", "/workspaces/repo1/one");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ repoName: "repo1", name: "one", ship: "ship-a" });
    expect((await call("GET", "/workspaces/nope/gone")).status).toBe(404);
  });

  test("GET /workspaces/:repo/:name/diff proxies raw diff text (200) or 404s", async () => {
    const ok = await callText("/workspaces/repo1/one/diff");
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("diff for repo1/one");

    expect((await callText("/workspaces/nope/gone/diff")).status).toBe(404);
  });

  test("POST /workspaces: 201 create, 400 unknown ship/repo, 409 duplicate, 422 invalid", async () => {
    await call("POST", "/repos", { name: "repo1", url: "git@fake/repo1.git" });
    await call("POST", "/repos", { name: "repo3", url: "git@fake/repo3.git" });

    const created = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo3",
      name: "three",
      branch: "main",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ repoName: "repo3", name: "three", ship: "ship-a" });

    // Unknown ship.
    expect(
      (await call("POST", "/workspaces", { ship: "ghost", repoName: "repo3", name: "n", branch: "main" })).status,
    ).toBe(400);
    // Unregistered repo.
    expect(
      (await call("POST", "/workspaces", { ship: "ship-a", repoName: "ghost-repo", name: "n", branch: "main" }))
        .status,
    ).toBe(400);
    // Duplicate workspace (repo1/one already synced from ship-a).
    expect(
      (await call("POST", "/workspaces", { ship: "ship-a", repoName: "repo1", name: "one", branch: "main" })).status,
    ).toBe(409);
    // Missing `ship`.
    expect((await call("POST", "/workspaces", { repoName: "repo3", name: "n", branch: "main" })).status).toBe(422);
  });

  test("POST /workspaces rejects a concurrent duplicate before a second ship call", async () => {
    await call("POST", "/repos", { name: "repo3", url: "git@fake/repo3.git" });
    const entered = deferred();
    const release = deferred();
    const ship = ships.get("http://ship-a")!;
    ship.createGate = { entered: entered.resolve, wait: release.promise };
    const body = { ship: "ship-a", repoName: "repo3", name: "three", branch: "main" };

    const first = call("POST", "/workspaces", body);
    await entered.promise;
    const second = await call("POST", "/workspaces", body);

    expect(second.status).toBe(409);
    expect(ship.createCalls).toBe(1);
    release.resolve();
    expect((await first).status).toBe(201);
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

  test("repo registry: GET/POST/DELETE /repos", async () => {
    expect((await call("GET", "/repos")).body).toEqual([]);

    const created = await call("POST", "/repos", { name: "repo1", url: "git@fake/repo1.git" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ name: "repo1", url: "git@fake/repo1.git", provider: "custom" });

    expect((await call("POST", "/repos", { name: "repo2", url: "u", provider: "github" })).status).toBe(201);
    // Duplicate name.
    expect((await call("POST", "/repos", { name: "repo1", url: "u" })).status).toBe(409);
    // Missing url.
    expect((await call("POST", "/repos", { name: "x" })).status).toBe(422);

    const list = await call("GET", "/repos");
    expect(list.body.map((r: { name: string }) => r.name).sort()).toEqual(["repo1", "repo2"]);

    expect((await call("DELETE", "/repos/repo1")).status).toBe(200);
    expect((await call("DELETE", "/repos/repo1")).status).toBe(404);
  });

  test("invalid repo and workspace identifiers return 400", async () => {
    expect((await call("POST", "/repos", { name: "bad\\repo", url: "url" })).status).toBe(400);
    expect(
      (await call("POST", "/workspaces", { ship: "ship-a", repoName: "repo1", name: "..", branch: "main" }))
        .status,
    ).toBe(400);
  });

  test("malformed upstream workspace summaries return 502", async () => {
    await call("POST", "/repos", { name: "repo3", url: "git@fake/repo3.git" });
    ships.get("http://ship-a")!.createResponse = { repoName: "wrong", name: "ws", branch: "main", active: false };

    const response = await call("POST", "/workspaces", {
      ship: "ship-a",
      repoName: "repo3",
      name: "ws",
      branch: "main",
    });
    expect(response.status).toBe(502);
  });
});
