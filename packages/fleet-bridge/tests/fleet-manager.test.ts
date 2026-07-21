import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, FleetManager } from "../src/fleet-manager";
import { Store } from "../src/store/store";
import { FakeSocket, makeDeps, ws, type FakeShip } from "./helpers";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("FleetManager", () => {
  let dir: string;
  let store: Store;
  let manager: FleetManager | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-mgr-"));
    FakeSocket.byBase.clear();
    store = new Store(dir);
    await store.load();
  });
  afterEach(async () => {
    manager?.shutdown();
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Seed the roster into the shared store the manager reads from. */
  async function seed(rows: { name: string; url: string }[]): Promise<void> {
    for (const row of rows) await store.createShip(row);
  }

  /** Register repos in the shared store so `createWorkspace` can resolve them. */
  async function seedRepos(rows: { name: string; url: string; provider?: string }[]): Promise<void> {
    for (const row of rows) await store.createRepo({ provider: "custom", ...row });
  }

  function build(ships: Map<string, FakeShip>, syncTimeoutMs?: number): FleetManager {
    manager = new FleetManager(
      { dataDirectory: dir, port: 4800, name: "bridge" },
      makeDeps(ships),
      { syncTimeoutMs: syncTimeoutMs ?? 1000, store },
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

    const rows = (await mgr.listWorkspaces()).sort((a, b) => a.repoName.localeCompare(b.repoName));
    expect(rows).toEqual([
      { repoName: "repo1", name: "one", branch: "main", active: true, ship: "ship-a" },
      { repoName: "repo2", name: "two", branch: "main", active: false, ship: "ship-b" },
    ]);
    expect(await mgr.listWorkspaces("active")).toHaveLength(1);
    expect(await mgr.listWorkspaces("inactive")).toHaveLength(1);
    expect(mgr.listShips().every((s) => s.status === "online")).toBe(true);
  });

  test("refreshes a branch changed on the ship without an event", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    const mgr = await boot(ships);

    expect((await mgr.listWorkspaces())[0]?.branch).toBe("main");
    const ship = ships.get("http://ship-a")!;
    ship.workspaces[0] = { ...ship.workspaces[0]!, branch: "feature" };

    expect((await mgr.listWorkspaces())[0]?.branch).toBe("feature");
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
    expect((await mgr.listWorkspaces()).map((w) => w.ship).sort()).toEqual(["ship-a", "ship-b"]);

    // Persisted to the roster store.
    const persisted = await store.getAllShips();
    expect(persisted.map((s) => s.name).sort()).toEqual(["ship-a", "ship-b"]);
  });

  test("rejects invalid ship identities at manager boundaries", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://bad-ship", { name: "../ship", workspaces: [] }],
    ]);
    const mgr = build(ships, 20);

    await expect(mgr.addShip("http://bad-ship")).rejects.toMatchObject({ status: 502 });
    await expect(mgr.removeShip("../ship")).rejects.toMatchObject({ status: 400 });
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
    expect(await mgr.listWorkspaces()).toHaveLength(0);
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
    expect((await mgr.listWorkspaces()).some((w) => w.repoName === "repo2" && w.name === "feature")).toBe(true);
  });

  test.each([
    ["empty", null],
    ["malformed", { repoName: "repo2", name: "feature" }],
    ["wrong identity", { repoName: "other", name: "feature", branch: "main", active: false }],
  ])("maps a %s upstream create summary to 502", async (_case, createResponse) => {
    const ship: FakeShip = { name: "ship-a", workspaces: [], createResponse };
    const ships = new Map<string, FakeShip>([["http://ship-a", ship]]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);
    await seedRepos([{ name: "repo2", url: "git@example/repo2.git" }]);
    const mgr = build(ships);
    await mgr.init();

    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo2", name: "feature", branch: "main" }),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo2", name: "feature", branch: "main" }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("outcome is unknown") });
    expect(ship.createCalls).toBe(1);

    FakeSocket.byBase.get("http://ship-a")!.emit(evt("workspace.created", "ship-a", ws("repo2", "feature")));
    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo2", name: "feature", branch: "main" }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already exists") });
  });

  test.each(["ship-a", "ship-b"])(
    "serializes concurrent creates for one key when the second targets %s",
    async (secondShip) => {
      const entered = deferred();
      const release = deferred();
      const ships = new Map<string, FakeShip>([
        [
          "http://ship-a",
          { name: "ship-a", workspaces: [], createGate: { entered: entered.resolve, wait: release.promise } },
        ],
        ["http://ship-b", { name: "ship-b", workspaces: [] }],
      ]);
      await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
      const mgr = await boot(ships);

      const first = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
      await entered.promise;
      await expect(
        mgr.createWorkspace({ ship: secondShip, repoName: "repo1", name: "one", branch: "main" }),
      ).rejects.toMatchObject({ status: 409 });

      expect(ships.get("http://ship-a")?.createCalls).toBe(1);
      expect(ships.get("http://ship-b")?.createCalls ?? 0).toBe(0);
      release.resolve();
      await expect(first).resolves.toMatchObject({ ship: "ship-a" });
      expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-a");
    },
  );

  test("does not reserve or dispatch when the target is removed during repo lookup", async () => {
    const lookupEntered = deferred();
    const releaseLookup = deferred();
    const originalGetRepo = store.getRepo.bind(store);
    store.getRepo = async (name) => {
      lookupEntered.resolve();
      await releaseLookup.promise;
      return originalGetRepo(name);
    };
    const shipA: FakeShip = { name: "ship-a", workspaces: [], createThenThrows: true };
    const shipB: FakeShip = { name: "ship-b", workspaces: [] };
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", shipA],
      ["http://ship-b", shipB],
    ]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);
    const input = { ship: "ship-a", repoName: "repo1", name: "one", branch: "main" };

    const create = mgr.createWorkspace(input);
    await lookupEntered.promise;
    await mgr.removeShip("ship-a");
    releaseLookup.resolve();

    await expect(create).rejects.toMatchObject({ status: 409, message: expect.stringContaining("was removed") });
    expect(shipA.createCalls ?? 0).toBe(0);
    await expect(mgr.createWorkspace({ ...input, ship: "ship-b" })).resolves.toMatchObject({ ship: "ship-b" });
    expect(shipB.createCalls).toBe(1);
  });

  test("allows different workspace keys to create concurrently", async () => {
    const bothEntered = deferred();
    const release = deferred();
    let entered = 0;
    const ship: FakeShip = {
      name: "ship-a",
      workspaces: [],
      createGate: {
        entered: () => {
          if (++entered === 2) bothEntered.resolve();
        },
        wait: release.promise,
      },
    };
    const ships = new Map([["http://ship-a", ship]]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);

    const first = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
    const second = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "two", branch: "main" });
    await bothEntered.promise;
    expect(ship.createCalls).toBe(2);

    release.resolve();
    await Promise.all([first, second]);
  });

  test("keeps an event-confirmed create routable when the response fails", async () => {
    const entered = deferred();
    const release = deferred();
    const ship: FakeShip = {
      name: "ship-a",
      workspaces: [],
      createResponse: { malformed: true },
      createGate: { entered: entered.resolve, wait: release.promise },
    };
    const ships = new Map([["http://ship-a", ship]]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);

    const create = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
    await entered.promise;
    FakeSocket.byBase.get("http://ship-a")!.emit(evt("workspace.created", "ship-a", ws("repo1", "one")));
    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 409 });

    release.resolve();
    await expect(create).rejects.toMatchObject({ status: 502 });
    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(ship.createCalls).toBe(1);
    expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-a");
  });

  test("keeps event-before-success creation idempotent", async () => {
    const entered = deferred();
    const release = deferred();
    const ship: FakeShip = {
      name: "ship-a",
      workspaces: [],
      createGate: { entered: entered.resolve, wait: release.promise },
    };
    const ships = new Map([["http://ship-a", ship]]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);

    const create = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
    await entered.promise;
    FakeSocket.byBase.get("http://ship-a")!.emit(evt("workspace.created", "ship-a", ws("repo1", "one")));
    release.resolve();

    await expect(create).resolves.toMatchObject({ ship: "ship-a" });
    expect((await mgr.listWorkspaces()).filter((workspace) => workspace.name === "one")).toEqual([
      { ...ws("repo1", "one"), ship: "ship-a" },
    ]);
    expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-a");
  });

  test("releases a failed create reservation for retry", async () => {
    const ship: FakeShip = {
      name: "ship-a",
      workspaces: [],
      errorResponse: { status: 500, message: "create failed" },
    };
    const ships = new Map([["http://ship-a", ship]]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);
    const input = { ship: "ship-a", repoName: "repo1", name: "one", branch: "main" };

    await expect(mgr.createWorkspace(input)).rejects.toMatchObject({ status: 500 });
    ship.errorResponse = undefined;
    await expect(mgr.createWorkspace(input)).resolves.toMatchObject({ ship: "ship-a" });
    expect(ship.createCalls).toBe(2);
  });

  test("blocks retries after an ambiguous create until the intended ship confirms it", async () => {
    const shipA: FakeShip = { name: "ship-a", workspaces: [], createThenThrows: true };
    const shipB: FakeShip = { name: "ship-b", workspaces: [] };
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", shipA],
      ["http://ship-b", shipB],
    ]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);

    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining("offline") });
    await expect(
      mgr.createWorkspace({ ship: "ship-b", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("outcome is unknown") });
    expect(shipA.createCalls).toBe(1);
    expect(shipB.createCalls ?? 0).toBe(0);

    FakeSocket.byBase.get("http://ship-a")!.emit(evt("workspace.created", "ship-a", ws("repo1", "one")));
    await expect(
      mgr.createWorkspace({ ship: "ship-b", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already exists") });
    expect((await mgr.listWorkspaces()).find((workspace) => workspace.name === "one")?.ship).toBe("ship-a");
  });

  test("an absent target snapshot stays blocked until administrative ship removal", async () => {
    const shipA: FakeShip = { name: "ship-a", workspaces: [], createThenThrows: true };
    const shipB: FakeShip = { name: "ship-b", workspaces: [] };
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", shipA],
      ["http://ship-b", shipB],
    ]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);

    await expect(
      mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({ status: 503 });
    shipA.workspaces = [];
    FakeSocket.byBase.get("http://ship-a")!.emit({
      type: "sync",
      ship: "ship-a",
      at: "2026-01-01T00:00:01.000Z",
      workspaces: [],
    });

    await expect(
      mgr.createWorkspace({ ship: "ship-b", repoName: "repo1", name: "one", branch: "main" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("remove that ship to clear the reservation"),
    });
    expect(shipB.createCalls ?? 0).toBe(0);

    await mgr.removeShip("ship-a");
    await expect(
      mgr.createWorkspace({ ship: "ship-b", repoName: "repo1", name: "one", branch: "main" }),
    ).resolves.toMatchObject({ ship: "ship-b" });
    expect(shipA.createCalls).toBe(1);
    expect(shipB.createCalls).toBe(1);
    expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-b");
  });

  test("rejects a target create response when another ship claims the key in flight", async () => {
    const entered = deferred();
    const release = deferred();
    const shipA: FakeShip = {
      name: "ship-a",
      workspaces: [],
      createGate: { entered: entered.resolve, wait: release.promise },
    };
    const shipB: FakeShip = { name: "ship-b", workspaces: [] };
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", shipA],
      ["http://ship-b", shipB],
    ]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);

    const create = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
    await entered.promise;
    FakeSocket.byBase.get("http://ship-b")!.emit(evt("workspace.created", "ship-b", ws("repo1", "one")));
    release.resolve();

    await expect(create).rejects.toMatchObject({ status: 409, message: expect.stringContaining('ship "ship-b"') });
    expect(shipA.createCalls).toBe(1);
    expect(shipB.createCalls ?? 0).toBe(0);
    expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-b");
  });

  test.each(["workspace", "ship"])(
    "re-elects a confirmed secondary after the foreign owner %s is removed",
    async (removal) => {
      const entered = deferred();
      const release = deferred();
      const shipA: FakeShip = {
        name: "ship-a",
        workspaces: [],
        createGate: { entered: entered.resolve, wait: release.promise },
      };
      const shipB: FakeShip = { name: "ship-b", workspaces: [] };
      const ships = new Map<string, FakeShip>([
        ["http://ship-a", shipA],
        ["http://ship-b", shipB],
      ]);
      await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
      const mgr = await boot(ships);
      const socketA = FakeSocket.byBase.get("http://ship-a")!;
      const socketB = FakeSocket.byBase.get("http://ship-b")!;

      const create = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
      await entered.promise;
      socketB.emit(evt("workspace.created", "ship-b", ws("repo1", "one")));
      socketA.emit(evt("workspace.created", "ship-a", ws("repo1", "one")));
      release.resolve();
      await expect(create).rejects.toMatchObject({ status: 409 });
      expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-b");

      if (removal === "workspace") socketB.emit(evt("workspace.removed", "ship-b", ws("repo1", "one")));
      else await mgr.removeShip("ship-b");

      expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-a");
      await expect(
        mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already exists") });
      expect(shipA.createCalls).toBe(1);
    },
  );

  test("allows target success when an in-flight conflicting owner is removed first", async () => {
    const entered = deferred();
    const release = deferred();
    const shipA: FakeShip = {
      name: "ship-a",
      workspaces: [],
      createGate: { entered: entered.resolve, wait: release.promise },
    };
    const shipB: FakeShip = { name: "ship-b", workspaces: [] };
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", shipA],
      ["http://ship-b", shipB],
    ]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = await boot(ships);
    const socketB = FakeSocket.byBase.get("http://ship-b")!;

    const create = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
    await entered.promise;
    socketB.emit(evt("workspace.created", "ship-b", ws("repo1", "one")));
    socketB.emit(evt("workspace.removed", "ship-b", ws("repo1", "one")));
    release.resolve();

    await expect(create).resolves.toMatchObject({ ship: "ship-a" });
    expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-a");
  });

  test("addShip rejects a snapshot colliding with an in-flight create", async () => {
    const entered = deferred();
    const release = deferred();
    const ships = new Map<string, FakeShip>([
      [
        "http://ship-a",
        {
          name: "ship-a",
          workspaces: [],
          createGate: { entered: entered.resolve, wait: release.promise },
        },
      ],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo1", "one")] }],
    ]);
    await seed([{ name: "ship-a", url: "http://ship-a" }]);
    await seedRepos([{ name: "repo1", url: "git@example/repo1.git" }]);
    const mgr = build(ships);
    await mgr.init();

    const create = mgr.createWorkspace({ ship: "ship-a", repoName: "repo1", name: "one", branch: "main" });
    await entered.promise;
    await expect(mgr.addShip("http://ship-b")).rejects.toMatchObject({ status: 409 });
    release.resolve();

    await expect(create).resolves.toMatchObject({ ship: "ship-a" });
    expect(mgr.listShips().map((ship) => ship.name)).toEqual(["ship-a"]);
    expect((await mgr.getWorkspace("repo1", "one")).ship).toBe("ship-a");
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

  test.each([
    ["malformed", { state: "inactive", repoName: "repo1" }],
    ["wrong identity", { state: "inactive", repoName: "repo1", name: "other", branch: "main" }],
  ])("maps a %s detailed workspace status to 502", async (_case, statusResponse) => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")], statusResponse }],
    ]);
    const mgr = await boot(ships);
    await expect(mgr.getWorkspace("repo1", "one")).rejects.toMatchObject({ status: 502 });
  });

  test("maps a malformed workspace snapshot to 502", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")], workspaceSnapshot: [{ name: "one" }] }],
    ]);
    const mgr = await boot(ships);
    await expect(mgr.listWorkspaces()).rejects.toMatchObject({ status: 502 });
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

  test("concurrent addRepo calls atomically produce one success and one conflict", async () => {
    const mgr = build(new Map());
    const results = await Promise.allSettled([
      mgr.addRepo({ name: "repo", url: "first" }),
      mgr.addRepo({ name: "repo", url: "second" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(await mgr.listRepos()).toHaveLength(1);
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
    expect(await mgr.listWorkspaces()).toHaveLength(1);
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
    ships.get("http://ship-a")!.throws = true;

    // created -> appears; branch_changed/activated -> upsert; removed -> gone.
    socket.emit(evt("workspace.created", "ship-a", ws("repo1", "two")));
    expect((await mgr.listWorkspaces()).map((w) => w.name).sort()).toEqual(["one", "two"]);

    socket.emit(evt("workspace.activated", "ship-a", ws("repo1", "two", true)));
    expect((await mgr.listWorkspaces()).find((w) => w.name === "two")?.active).toBe(true);

    socket.emit(evt("workspace.removed", "ship-a", ws("repo1", "one")));
    expect((await mgr.listWorkspaces()).map((w) => w.name)).toEqual(["two"]);
  });

  test("a fresh sync fully replaces a ship's contribution (resync)", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one"), ws("repo1", "two")] }],
    ]);
    const mgr = await boot(ships);
    const socket = FakeSocket.byBase.get("http://ship-a")!;
    ships.get("http://ship-a")!.throws = true;

    // Reconnect delivers a new snapshot: "one" is gone, "three" is new.
    socket.emit({
      type: "sync",
      ship: "ship-a",
      at: "2026-01-01T00:00:01.000Z",
      workspaces: [ws("repo1", "two"), ws("repo1", "three")],
    });

    expect((await mgr.listWorkspaces()).map((w) => w.name).sort()).toEqual(["three", "two"]);
  });

  test("ignores identity-mismatched events without desynchronizing manager keys", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    const mgr = await boot(ships);
    ships.get("http://ship-a")!.throws = true;
    const socket = FakeSocket.byBase.get("http://ship-a")!;

    socket.emit(evt("workspace.created", "ship-b", ws("repo1", "injected")));
    socket.emit({
      type: "sync",
      ship: "ship-b",
      at: "2026-01-01T00:00:01.000Z",
      workspaces: [ws("repo2", "replacement")],
    });

    expect(mgr.listShips().map((ship) => ship.name)).toEqual(["ship-a"]);
    expect((await mgr.listWorkspaces()).map((workspace) => workspace.name)).toEqual(["one"]);
    await expect(mgr.getWorkspace("repo1", "injected")).rejects.toMatchObject({ status: 404 });
  });

  test("runtime duplicate collision keeps the first owner (first-writer-wins)", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
    ]);
    const mgr = await boot(ships);
    ships.get("http://ship-b")!.throws = true;

    // ship-b independently reports repo1/one — ship-a already owns it.
    FakeSocket.byBase.get("http://ship-b")!.emit(evt("workspace.created", "ship-b", ws("repo1", "one")));

    const rows = (await mgr.listWorkspaces()).filter((w) => w.repoName === "repo1" && w.name === "one");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ship).toBe("ship-a");
  });

  test("ownership re-election prefers an online confirmed ship before name order", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://owner", { name: "owner", workspaces: [ws("repo1", "one")] }],
      ["http://offline-a", { name: "offline-a", workspaces: [] }],
      ["http://online-z", { name: "online-z", workspaces: [] }],
    ]);
    const mgr = await boot(ships);
    const workspace = ws("repo1", "one");
    ships.get("http://offline-a")!.workspaces.push(workspace);
    ships.get("http://online-z")!.workspaces.push(workspace);
    FakeSocket.byBase.get("http://offline-a")!.emit(evt("workspace.created", "offline-a", workspace));
    FakeSocket.byBase.get("http://online-z")!.emit(evt("workspace.created", "online-z", workspace));

    ships.delete("http://offline-a");
    FakeSocket.byBase.get("http://offline-a")!.close();
    ships.get("http://owner")!.throws = true;
    FakeSocket.byBase.get("http://owner")!.emit(evt("workspace.removed", "owner", workspace));

    expect((await mgr.listWorkspaces()).find((row) => row.name === "one")?.ship).toBe("online-z");
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
    expect((await mgr.listWorkspaces()).map((w) => w.name)).toEqual(["one"]);
  });
});
