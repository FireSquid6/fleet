import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { WorkspaceSummary } from "fleet-protocol";
import { BridgeError, FleetManager } from "../../apps/fleet-bridge/src/fleet-manager";
import type { ShipConnectionDeps, SocketLike } from "../../apps/fleet-bridge/src/ship-connection";
import { saveStore } from "../../apps/fleet-bridge/src/store";

/** A ship the fakes will pretend exists at a given base URL. */
interface FakeShip {
  name: string;
  workspaces: WorkspaceSummary[];
}

function repoBasename(repoUrlOrName: string): string {
  const base = basename(repoUrlOrName);
  return base.endsWith(".git") ? base.slice(0, -".git".length) : base;
}

/** Reduce a `ws://host/events` url back to its `http://host` base. */
function httpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return u.origin;
}

/** A fake `/events` socket that emits one `sync` (or errors if the ship is absent). */
class FakeSocket implements SocketLike {
  /** Latest socket opened per ship base url, so a test can close it to force offline. */
  static readonly byBase = new Map<string, FakeSocket>();

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private done = false;

  constructor(wsUrl: string, ships: Map<string, FakeShip>) {
    const base = httpBase(wsUrl);
    FakeSocket.byBase.set(base, this);
    const ship = ships.get(base);
    setTimeout(() => {
      if (this.done) return;
      if (!ship) {
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.onopen?.({});
      this.onmessage?.({
        data: JSON.stringify({
          type: "sync",
          ship: ship.name,
          at: "2026-01-01T00:00:00.000Z",
          workspaces: ship.workspaces,
        }),
      });
    }, 0);
  }

  close(): void {
    this.done = true;
    this.onclose?.({});
  }
}

/** A fake Eden client covering the ship endpoints the manager calls. */
function makeFakeClient(httpUrl: string, ships: Map<string, FakeShip>) {
  const ship = () => ships.get(httpUrl);
  const workspacesFn: any = (params: { repo: string }) => (params2: { name: string }) => ({
    get: async () => ({
      data: { state: "inactive", repo: params.repo, name: params2.name, branch: "main" },
      error: null,
    }),
    branch: { post: async () => ({ data: { ok: true }, error: null }) },
    activate: { post: async () => ({ data: { ok: true }, error: null }) },
    deactivate: { post: async () => ({ data: { ok: true }, error: null }) },
    delete: async () => ({ data: { ok: true }, error: null }),
  });
  workspacesFn.get = async () => ({ data: [...(ship()?.workspaces ?? [])], error: null });
  workspacesFn.post = async (body: { repo: string; name: string; branch: string }) => ({
    data: { repo: repoBasename(body.repo), name: body.name, branch: body.branch, active: false },
    error: null,
  });
  return { workspaces: workspacesFn };
}

function makeDeps(ships: Map<string, FakeShip>): Partial<ShipConnectionDeps> {
  return {
    createSocket: (url) => new FakeSocket(url, ships),
    createClient: (url) => makeFakeClient(url, ships) as unknown as ReturnType<ShipConnectionDeps["createClient"]>,
  };
}

const ws = (repo: string, name: string, active = false): WorkspaceSummary => ({
  repo,
  name,
  branch: "main",
  active,
});

describe("FleetManager", () => {
  let dir: string;
  let manager: FleetManager | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-mgr-"));
    FakeSocket.byBase.clear();
  });
  afterEach(async () => {
    manager?.shutdown();
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function build(ships: Map<string, FakeShip>): FleetManager {
    manager = new FleetManager({ dataDirectory: dir, port: 4800, name: "bridge" }, makeDeps(ships));
    return manager;
  }

  test("aggregates workspaces across ships, annotated with the owning ship", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one", true)] }],
      ["http://ship-b", { name: "ship-b", workspaces: [ws("repo2", "two")] }],
    ]);
    await saveStore(dir, [
      { name: "ship-a", url: "http://ship-a" },
      { name: "ship-b", url: "http://ship-b" },
    ]);

    const mgr = build(ships);
    await mgr.init();

    const rows = mgr.listWorkspaces().sort((a, b) => a.repo.localeCompare(b.repo));
    expect(rows).toEqual([
      { repo: "repo1", name: "one", branch: "main", active: true, ship: "ship-a" },
      { repo: "repo2", name: "two", branch: "main", active: false, ship: "ship-b" },
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
    await saveStore(dir, [
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
    await saveStore(dir, [{ name: "ship-a", url: "http://ship-a" }]);

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
    await saveStore(dir, [{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    const info = await mgr.addShip("http://ship-b");
    expect(info).toMatchObject({ name: "ship-b", url: "http://ship-b", status: "online" });
    expect(mgr.listWorkspaces().map((w) => w.ship).sort()).toEqual(["ship-a", "ship-b"]);

    // Persisted to disk.
    const persisted = JSON.parse(await Bun.file(join(dir, "ships.json")).text());
    expect(persisted.ships.map((s: { name: string }) => s.name).sort()).toEqual(["ship-a", "ship-b"]);
  });

  test("removeShip unregisters and drops its workspaces", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await saveStore(dir, [{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();
    await mgr.removeShip("ship-a");

    expect(mgr.listShips()).toHaveLength(0);
    expect(mgr.listWorkspaces()).toHaveLength(0);
    await expect(mgr.removeShip("ship-a")).rejects.toMatchObject({ status: 404 });
  });

  test("createWorkspace targets the named ship and rejects unknown ships / duplicates", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await saveStore(dir, [{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    await expect(
      mgr.createWorkspace({ repo: "r", name: "n", branch: "main", ship: "ghost" }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      mgr.createWorkspace({ repo: "repo1", name: "one", branch: "main", ship: "ship-a" }),
    ).rejects.toMatchObject({ status: 409 });

    const created = await mgr.createWorkspace({
      repo: "git@github.com:acme/repo2.git",
      name: "feature",
      branch: "dev",
      ship: "ship-a",
    });
    expect(created).toEqual({ repo: "repo2", name: "feature", branch: "dev", active: false, ship: "ship-a" });
    // Optimistically visible immediately.
    expect(mgr.listWorkspaces().some((w) => w.repo === "repo2" && w.name === "feature")).toBe(true);
  });

  test("getWorkspace proxies to the owning ship and annotates the ship", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await saveStore(dir, [{ name: "ship-a", url: "http://ship-a" }]);

    const mgr = build(ships);
    await mgr.init();

    const status = await mgr.getWorkspace("repo1", "one");
    expect(status).toMatchObject({ state: "inactive", repo: "repo1", name: "one", ship: "ship-a" });
    await expect(mgr.getWorkspace("nope", "gone")).rejects.toMatchObject({ status: 404 });
  });

  test("routes to 503 when the owning ship goes offline", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await saveStore(dir, [{ name: "ship-a", url: "http://ship-a" }]);

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
});
