import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmorySyncState } from "fleet-protocol";
import { createApp } from "../src/api";
import { FleetManager } from "../src/fleet-manager";
import { Store } from "../src/store/store";
import { FakeSocket, makeDeps, makeTestAuth, type FakeShip } from "./helpers";

const SYNCED: ArmorySyncState = {
  revision: "a".repeat(64),
  bridgeUrl: "http://bridge.example:4800",
  syncedAt: "2026-01-01T00:00:00.000Z",
  fileCount: 3,
  install: {
    skillCount: 2,
    pluginCount: 1,
    dotfileCount: 1,
    removedCount: 0,
    conflicts: [],
    warnings: [],
    installedAt: "2026-01-01T00:00:01.000Z",
  },
  lastError: null,
};

describe("FleetManager armoryShipStates", () => {
  let dir: string;
  let store: Store;
  let manager: FleetManager | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-armory-ships-"));
    FakeSocket.byBase.clear();
    store = new Store(dir);
    await store.load();
  });
  afterEach(async () => {
    manager?.shutdown();
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function boot(ships: Map<string, FakeShip>): Promise<FleetManager> {
    for (const [url, ship] of ships) await store.createShip({ name: ship.name, url });
    manager = new FleetManager({ dataDirectory: dir, port: 4800, name: "bridge" }, makeDeps(ships), {
      syncTimeoutMs: 1000,
      store,
    });
    await manager.init();
    return manager;
  }

  test("reports each ship's state, and null for one that is offline or failing", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [], armoryState: SYNCED }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
      [
        "http://ship-c",
        { name: "ship-c", workspaces: [], errorResponse: { status: 500, message: "cache unreadable" } },
      ],
    ]);
    const mgr = await boot(ships);
    FakeSocket.byBase.get("http://ship-b")!.close();

    const states = await mgr.armoryShipStates();

    expect(states).toEqual([
      { ship: "ship-a", status: "online", state: SYNCED },
      { ship: "ship-b", status: "offline", state: null },
      { ship: "ship-c", status: "online", state: null },
    ]);
  });

  test("a ship that has never synced reports a state rather than null", async () => {
    const ships = new Map<string, FakeShip>([["http://ship-a", { name: "ship-a", workspaces: [] }]]);
    const mgr = await boot(ships);

    const states = await mgr.armoryShipStates();

    expect(states).toEqual([
      {
        ship: "ship-a",
        status: "online",
        state: { revision: null, bridgeUrl: null, syncedAt: null, fileCount: 0, install: null, lastError: null },
      },
    ]);
  });

  test("an unreachable ship is reported offline, not thrown", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [], armoryState: SYNCED }],
      ["http://ship-b", { name: "ship-b", workspaces: [], throws: true }],
    ]);
    const mgr = await boot(ships);

    const states = await mgr.armoryShipStates();

    expect(states).toEqual([
      { ship: "ship-a", status: "online", state: SYNCED },
      { ship: "ship-b", status: "offline", state: null },
    ]);
  });

  test("GET /armory/ships serves the aggregate", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [], armoryState: SYNCED }],
    ]);
    const mgr = await boot(ships);
    const app = createApp(mgr, makeTestAuth());

    const response = await app.handle(new Request("http://bridge/armory/ships"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ ship: "ship-a", status: "online", state: SYNCED }]);
  });
});
