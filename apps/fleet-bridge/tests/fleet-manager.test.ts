import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, FleetManager } from "../src/fleet-manager";
import { getDb, type Db } from "../src/db";
import { ShipService } from "../src/services/ship-service";
import { ProjectRepoService } from "../src/services/project-repo-service";
import { FakeSocket, makeDeps, ws, type FakeShip } from "./helpers";

describe("FleetManager", () => {
  let dir: string;
  let db: Db;
  let manager: FleetManager | undefined;

  beforeEach(async () => {
    // `dir` is only a `dataDirectory` placeholder; the DB is in-memory (ephemeral).
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-mgr-"));
    FakeSocket.byBase.clear();
    db = getDb({ dataDirectory: dir, port: 4800, name: "bridge", ephemeralDb: true });
  });
  afterEach(async () => {
    manager?.shutdown();
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Seed the roster into the shared in-memory DB the manager reads from. */
  async function seed(rows: { name: string; url: string }[]): Promise<void> {
    const ships = new ShipService(db);
    for (const row of rows) await ships.createShip(row);
  }

  /** Register repos in the shared DB so `createWorkspace` can resolve them. */
  async function seedRepos(rows: { name: string; url: string; provider?: string }[]): Promise<void> {
    const repos = new ProjectRepoService(db);
    for (const row of rows) await repos.createRepo({ provider: "custom", ...row });
  }

  function build(ships: Map<string, FakeShip>, syncTimeoutMs?: number): FleetManager {
    manager = new FleetManager(
      { dataDirectory: dir, port: 4800, name: "bridge", ephemeralDb: true },
      makeDeps(ships),
      { syncTimeoutMs: syncTimeoutMs ?? 1000, db },
    );
    return manager;
  }

  /** Register `ships` in the DB and init a manager against them. */
  async function boot(ships: Map<string, FakeShip>, syncTimeoutMs?: number): Promise<FleetManager> {
    await seed([...ships.keys()].map((url) => ({ name: ships.get(url)!.name, url })));
    const mgr = build(ships, syncTimeoutMs);
    await mgr.init();
    return mgr;
  }

  test("aggregates workspaces across ships, annotated with the owning ship", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one", true)] }],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo2", "two")] }],
    ]);
    await seed([
      { name: "ship-a", url: "http://ship-a" },
      { name: "ship-b", url: "http://ship-b" },
    ]);

    const mgr = build(ships);
    await mgr.init();

    const rows = mgr.listWorkspaces().sort((a, b) => a.repoName.localeCompare(b.repoName));
    expect(rows).toEqual([
      { repoName: "repo1", name: "one", branch: "main", active: true, ship: "ship-a" },
      { repoName: "repo2", name: "two", branch: "main", active: false, ship: "ship-b" },
    ]);
    expect(mgr.listWorkspaces("active")).toHaveLength(1);
    expect(mgr.listWorkspaces("inactive")).toHaveLength(1);
    expect(mgr.listShips().every((s) => s.status === "online")).toBe(true);
  });

  test("aborts startup when two reachable ships hold the same repo/name", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "dup")] }],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo1", "dup")] }],
    ]);
    await seed([
      { name: "ship-a", url: "http://ship-a" },
      { name: "ship-b", url: "http://ship-b" },
    ]);

    const mgr = build(ships);
    await expect(mgr.init()).rejects.toThrow(/duplicate/i);
  });

  test("addShip rejects a ship that would introduce a duplicate", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo1", "one")] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    await expect(mgr.addShip("http://ship-b")).rejects.toMatchObject({ status: 409 });
    expect(mgr.listShips().map((s) => s.name)).toEqual(["ship-a"]);
  });

  test("addShip adopts a clean ship and persists the roster", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo2", "two")] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    const info = await mgr.addShip("http://ship-b");
    expect(info).toMatchObject({ name: "ship-b", url: "http://ship-b", status: "online" });
    expect(mgr.listWorkspaces().map((w) => w.ship).sort()).toEqual(["ship-a", "ship-b"]);

    // Persisted to the roster DB.
    const persisted = await new ShipService(db).getAllShips();
    expect(persisted.map((s) => s.name).sort()).toEqual(["ship-a", "ship-b"]);
  });

  test("removeShip unregisters and drops its workspaces", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();
    await mgr.removeShip("ship-a");

    expect(mgr.listShips()).toHaveLength(0);
    expect(mgr.listWorkspaces()).toHaveLength(0);
    await expect(mgr.removeShip("ship-a")).rejects.toMatchObject({ status: 404 });
  });

  test("createWorkspace targets the named ship and rejects unknown ships / repos / duplicates", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);
    await seedRepos([
      { name: "repo1", url: "git@github.com:acme/repo1.git" },
      { name: "repo2", url: "git@github.com:acme/repo2.git" },
    ]);

    const mgr = build(ships);
    await mgr.init();

    // Unknown ship (checked before the repo).
    await expect(
      mgr.createWorkspace({ ship: "ghost", repoName: "repo1", name: "n", branch: "main" }),
    ).rejects.toMatchObject({ status: 400 });

    // Unregistered repo.
    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "ghost-repo", name: "n", branch: "main" }),
    ).rejects.toMatchObject({ status: 400 });

    // Duplicate workspace.
    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 409 });

    const created = await mgr.createWorkspace({
      ship: "ship-a",
      repoName: "repo2",
      name: "feature",
      branch: "dev",
    });
    expect(created).toEqual({ repoName: "repo2", name: "feature", branch: "dev", active: false, ship: "ship-a" });
    // Optimistically visible immediately.
    expect(mgr.listWorkspaces().some((w) => w.repoName === "repo2" && w.name === "feature")).toBe(true);
  });

  test("getWorkspace proxies to the owning ship and annotates the ship", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    const status = await mgr.getWorkspace("repo1", "one");
    expect(status).toMatchObject({ state: "inactive", repoName: "repo1", name: "one", ship: "ship-a" });
    await expect(mgr.getWorkspace("nope", "gone")).rejects.toMatchObject({ status: 404 });
  });

  test("getShipSystemResources proxies one ship; unknown -> 400", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    const res = await mgr.getShipSystemResources("ship-a");
    expect(res.os.hostname).toBe("ship-a");
    expect(res.cpu.cores).toBe(8);
    await expect(mgr.getShipSystemResources("ghost")).rejects.toMatchObject({ status: 400 });
  });

  test("listSystemResources aggregates all ships; offline ones report null", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [] }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
    ]);
    await seed([
      { name: "ship-a", url: "http://ship-a" },
      { name: "ship-b", url: "http://ship-b" },
    ]);

    const mgr = build(ships);
    await mgr.init();

    // Take ship-b offline (drop it so a reconnect can't revive it, then close).
    ships.delete("http://ship-b");
    FakeSocket.byBase.get("http://ship-b")?.close();

    const all = (await mgr.listSystemResources()).sort((a, b) => a.ship.localeCompare(b.ship));
    expect(all).toHaveLength(2);

    const a = all.find((r) => r.ship === "ship-a")!;
    expect(a.status).toBe("online");
    expect(a.resources?.os.hostname).toBe("ship-a");
    expect(a.error).toBeNull();

    const b = all.find((r) => r.ship === "ship-b")!;
    expect(b.status).toBe("offline");
    expect(b.resources).toBeNull();
  });

  test("addRepo registers a repo (default provider), rejects duplicates, and lists them", async () => {
    const mgr = build(new Map());

    const created = await mgr.addRepo({ name: "repo1", url: "git@fake/repo1.git" });
    expect(created).toEqual({ name: "repo1", url: "git@fake/repo1.git", provider: "custom" });

    await mgr.addRepo({ name: "repo2", url: "git@fake/repo2.git", provider: "github" });

    await expect(mgr.addRepo({ name: "repo1", url: "other" })).rejects.toMatchObject({ status: 409 });

    const repos = (await mgr.listRepos()).sort((a, b) => a.name.localeCompare(b.name));
    expect(repos).toEqual([
      { name: "repo1", url: "git@fake/repo1.git", provider: "custom" },
      { name: "repo2", url: "git@fake/repo2.git", provider: "github" },
    ]);
  });

  test("removeRepo deletes a repo; unknown -> 404", async () => {
    const mgr = build(new Map());
    await mgr.addRepo({ name: "repo1", url: "git@fake/repo1.git" });

    await mgr.removeRepo("repo1");
    expect(await mgr.listRepos()).toEqual([]);
    await expect(mgr.removeRepo("repo1")).rejects.toMatchObject({ status: 404 });
  });

  test("routes to 503 when the owning ship goes offline", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    // Drop the ship so a reconnect can't revive it, then close its live socket.
    ships.delete("http://ship-a");
    FakeSocket.byBase.get("http://ship-a")?.close();

    expect(mgr.listShips()[0]?.status).toBe("offline");
    // Workspace still listed (last-known), but mutations/status return 503.
    expect(mgr.listWorkspaces()).toHaveLength(1);
    await expect(mgr.getWorkspace("repo1", "one")).rejects.toMatchObject({ status: 503 });
    await expect(mgr.activate("repo1", "one")).rejects.toMatchObject({ status: 503 });

    expect(BridgeError).toBeDefined();
  });

  // --- runtime event application --------------------------------------------

  const evt = (type: string, ship: string, w: ReturnType<typeof ws>) => ({
    type,
    ship,
    at: "2026-01-01T00:00:00.000Z",
    workspace: w,
  });

  test("applies post-init change events into the aggregate index", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    const mgr = await boot(ships);
    const socket = FakeSocket.byBase.get("http://ship-a")!;

    // created -> appears; branch_changed/activated -> upsert; removed -> gone.
    socket.emit(evt("workspace.created", "ship-a", ws("repo1", "two")));
    expect(mgr.listWorkspaces().map((w) => w.name).sort()).toEqual(["one", "two"]);

    socket.emit(evt("workspace.activated", "ship-a", ws("repo1", "two", true)));
    expect(mgr.listWorkspaces().find((w) => w.name === "two")?.active).toBe(true);

    socket.emit(evt("workspace.removed", "ship-a", ws("repo1", "one")));
    expect(mgr.listWorkspaces().map((w) => w.name)).toEqual(["two"]);
  });

  test("a fresh sync fully replaces a ship's contribution (resync)", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one"), ws("repo1", "two")] }],
    ]);
    const mgr = await boot(ships);
    const socket = FakeSocket.byBase.get("http://ship-a")!;

    // Reconnect delivers a new snapshot: "one" is gone, "three" is new.
    socket.emit({
      type: "sync",
      ship: "ship-a",
      at: "2026-01-01T00:00:01.000Z",
      workspaces: [ws("repo1", "two"), ws("repo1", "three")],
    });

    expect(mgr.listWorkspaces().map((w) => w.name).sort()).toEqual(["three", "two"]);
  });

  test("runtime duplicate collision keeps the first owner (first-writer-wins)", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
    ]);
    const mgr = await boot(ships);

    // ship-b independently reports repo1/one — ship-a already owns it.
    FakeSocket.byBase.get("http://ship-b")!.emit(evt("workspace.created", "ship-b", ws("repo1", "one")));

    const rows = mgr.listWorkspaces().filter((w) => w.repoName === "repo1" && w.name === "one");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ship).toBe("ship-a");
  });

  // --- verb happy paths + error/offline translation -------------------------

  test("switchBranch / deactivate / remove reach the owning ship", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one", true)] }],
    ]);
    const mgr = await boot(ships);

    await expect(mgr.switchBranch("repo1", "one", "dev")).resolves.toBeUndefined();
    await expect(mgr.deactivate("repo1", "one")).resolves.toBeUndefined();
    await expect(mgr.remove("repo1", "one")).resolves.toBeUndefined();
  });

  test("surfaces a ship-side error with its status (call passthrough)", async () => {
    const ships = new Map<string, FakeShip>([
      [
        "http://ship-a",
        { name: "ship-a", workspaces: [ws("repo1", "one")], errorResponse: { status: 409, message: "boom" } },
      ],
    ]);
    const mgr = await boot(ships);

    await expect(mgr.switchBranch("repo1", "one", "dev")).rejects.toMatchObject({
      status: 409,
      message: "boom",
    });
  });

  test("a network failure flips the ship offline and returns 503", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")], throws: true }],
    ]);
    const mgr = await boot(ships);

    await expect(mgr.activate("repo1", "one")).rejects.toMatchObject({ status: 503 });
    expect(mgr.listShips()[0]?.status).toBe("offline");
  });

  // --- add / startup timeout ------------------------------------------------

  test("addShip returns 502 when the ship never syncs", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [] }],
      ["http://ship-b", { name: "ship-b", workspaces: [], neverSync: true }],
    ]);
    // Only ship-a is persisted; ship-b is reachable-but-silent and added at runtime.
    await seed([{ name: "ship-a", url: "http://ship-a" }]);
    const mgr = build(ships, 50);
    await mgr.init();

    await expect(mgr.addShip("http://ship-b")).rejects.toMatchObject({ status: 502 });
    expect(mgr.listShips().map((s) => s.name)).toEqual(["ship-a"]);
  });

  test("a persisted ship that is unreachable at startup stays offline (no abort)", async () => {
    // Only ship-a is reachable (present in the fakes map); ship-b's socket never opens.
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await seed([
      { name: "ship-a", url: "http://ship-a" },
      { name: "ship-b", url: "http://ship-b" },
    ]);
    const mgr = build(ships, 50);
    await mgr.init();

    const byName = Object.fromEntries(mgr.listShips().map((s) => [s.name, s.status]));
    expect(byName["ship-a"]).toBe("online");
    expect(byName["ship-b"]).toBe("offline");
    expect(mgr.listWorkspaces().map((w) => w.name)).toEqual(["one"]);
  });
});
