import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createShipApp } from "fleet-ship/api";
import type { ArmoryService } from "../src/armory/armory-service";
import type { AuthService } from "../src/auth/auth-service";
import { FleetManager } from "../src/fleet-manager";
import { Store } from "../src/store/store";
import { makeTestAuth } from "./helpers";

type ShipManager = Parameters<typeof createShipApp>[0];

const shipManager = () =>
  ({
    list: async () => [],
    subscribe: () => () => {},
    snapshotEvent: async () => ({
      type: "sync",
      ship: "ship-a",
      at: "2026-01-01T00:00:00.000Z",
      workspaces: [],
    }),
  }) as unknown as ShipManager;

const noArmory = {
  manifest: async () => {
    throw new Error("this test serves no armory");
  },
} as unknown as ArmoryService;

describe("bridge and ship authenticate each other", () => {
  let dir: string;
  let store: Store;
  let auth: AuthService;
  let manager: FleetManager | undefined;
  let ship: ReturnType<typeof createShipApp> | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-mutual-auth-"));
    store = new Store(dir);
    await store.load();
    auth = makeTestAuth();
  });

  afterEach(async () => {
    manager?.shutdown();
    manager = undefined;
    ship?.server?.stop(true);
    ship = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function startShip(bridgeToken?: string, shipToken?: string): string {
    ship = createShipApp(
      shipManager(),
      { fleetDirectory: dir, port: 0, name: "ship-a", bridgeToken, shipToken },
      undefined,
      undefined,
      undefined,
      {},
    );
    ship.listen(0);
    return `http://localhost:${ship.server?.port}`;
  }

  function buildManager(): FleetManager {
    manager = new FleetManager({ dataDirectory: dir, port: 4800, name: "bridge" }, undefined, {
      syncTimeoutMs: 2000,
      store,
      credentials: auth,
      armory: noArmory,
    });
    return manager;
  }

  test("a launched ship's minted pair gets the bridge in, over both the socket and HTTP", async () => {
    const credentials = auth.createShipCredentials("ship-a");
    const url = startShip(credentials.bridgeToken, credentials.shipToken);
    const mgr = buildManager();
    await mgr.init();

    const info = await mgr.addShip(url, credentials);

    expect(info).toMatchObject({ name: "ship-a", status: "online" });
    expect(await mgr.getShipSystemResources("ship-a")).toMatchObject({ os: { platform: expect.any(String) } });
  });

  test("the bridge cannot reach a token-holding ship without that ship's bridgeToken", async () => {
    const credentials = auth.createShipCredentials("ship-a");
    const url = startShip(credentials.bridgeToken, credentials.shipToken);
    const mgr = buildManager();
    await mgr.init();

    await expect(mgr.addShip(url)).rejects.toMatchObject({ status: 502 });
    await expect(
      mgr.addShip(url, { shipToken: "wrong", bridgeToken: "wrong" }),
    ).rejects.toMatchObject({ status: 502 });
    expect(mgr.listShips()).toHaveLength(0);
  });

  test("a ship with no bridgeToken still admits a bridge that has none", async () => {
    const url = startShip();
    const mgr = buildManager();
    await mgr.init();

    expect(await mgr.addShip(url)).toMatchObject({ name: "ship-a", status: "online" });
  });
});
