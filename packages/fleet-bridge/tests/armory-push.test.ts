import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher, WatchListener } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBridgeConfig } from "../src/config";
import { watchArmory } from "../src/armory/armory-watcher";
import { FleetManager } from "../src/fleet-manager";
import { Store } from "../src/store/store";
import { FakeSocket, makeDeps, ws, type FakeShip } from "./helpers";

const PUBLIC_URL = "http://bridge.example:4800";

describe("resolveBridgeConfig publicUrl", () => {
  test("defaults to localhost on the configured port", () => {
    const config = resolveBridgeConfig({ dataDirectory: ".", port: 4900, name: "bridge" });
    expect(config.publicUrl).toBe("http://localhost:4900");
  });

  test("keeps an explicit value", () => {
    const config = resolveBridgeConfig({ dataDirectory: ".", port: 4900, name: "bridge", publicUrl: PUBLIC_URL });
    expect(config.publicUrl).toBe(PUBLIC_URL);
  });
});

/** An `fs.watch` stand-in that hands the change listener back to the test. */
function fakeWatch() {
  const watcher = new EventEmitter() as EventEmitter & FSWatcher;
  watcher.close = () => {};
  let listener: WatchListener<string> | undefined;
  const watch = ((_directory: unknown, _options: unknown, given: WatchListener<string>) => {
    listener = given;
    return watcher;
  }) as unknown as typeof import("node:fs").watch;
  return { watch, watcher, fire: () => listener?.("change", "skills/one/SKILL.md") };
}

describe("watchArmory", () => {
  test("collapses a burst of events into one callback", async () => {
    const { watch, fire } = fakeWatch();
    let changes = 0;
    const handle = watchArmory("/armory", () => changes++, { watch, debounceMs: 20 });

    for (let i = 0; i < 5; i++) fire();
    await Bun.sleep(60);

    expect(changes).toBe(1);
    handle.close();
  });

  test("stops calling back once closed", async () => {
    const { watch, fire } = fakeWatch();
    let changes = 0;
    const handle = watchArmory("/armory", () => changes++, { watch, debounceMs: 20 });

    fire();
    handle.close();
    await Bun.sleep(60);

    expect(changes).toBe(0);
  });

  test("a missing directory is a no-op handle, not a throw", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-watch-"));
    try {
      const handle = watchArmory(join(directory, "armory"), () => {
        throw new Error("should never fire");
      });
      handle.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("FleetManager armory push", () => {
  let dir: string;
  let store: Store;
  let manager: FleetManager | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-push-"));
    FakeSocket.byBase.clear();
    store = new Store(dir);
    await store.load();
    await mkdir(join(dir, "armory", "skills", "one"), { recursive: true });
    await writeFile(join(dir, "armory", "skills", "one", "SKILL.md"), "# one\n");
  });
  afterEach(async () => {
    manager?.shutdown();
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function build(ships: Map<string, FakeShip>): FleetManager {
    manager = new FleetManager(
      { dataDirectory: dir, port: 4800, name: "bridge", publicUrl: PUBLIC_URL },
      makeDeps(ships),
      { syncTimeoutMs: 1000, store },
    );
    return manager;
  }

  async function boot(ships: Map<string, FakeShip>): Promise<FleetManager> {
    for (const [url, ship] of ships) await store.createShip({ name: ship.name, url });
    const mgr = build(ships);
    await mgr.init();
    return mgr;
  }

  /** Let the pushes that `init`/`addShip` fire off land, then forget them. */
  async function settle(ships: Map<string, FakeShip>): Promise<void> {
    await Bun.sleep(20);
    for (const ship of ships.values()) ship.armorySyncs = [];
  }

  test("pushes the current revision and the configured publicUrl to every online ship", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
    ]);
    const mgr = await boot(ships);
    await settle(ships);

    await mgr.pushArmory();

    const revision = (await mgr.armoryManifest()).revision;
    expect(ships.get("http://ship-a")!.armorySyncs).toEqual([{ bridgeUrl: PUBLIC_URL, revision }]);
    expect(ships.get("http://ship-b")!.armorySyncs).toEqual([{ bridgeUrl: PUBLIC_URL, revision }]);
  });

  test("skips offline ships", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [] }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
    ]);
    const mgr = await boot(ships);
    await settle(ships);
    FakeSocket.byBase.get("http://ship-b")!.close();

    await mgr.pushArmory();

    expect(ships.get("http://ship-a")!.armorySyncs).toHaveLength(1);
    expect(ships.get("http://ship-b")!.armorySyncs).toEqual([]);
  });

  test("a ship coming online is pushed to without anyone asking", async () => {
    const ships = new Map<string, FakeShip>([["http://ship-a", { name: "ship-a", workspaces: [] }]]);
    const mgr = await boot(ships);
    await settle(ships);

    // Drive the socket directly rather than waiting out the reconnect backoff:
    // the connection reacts to its socket closing and reopening, which is the
    // transition the push hangs off.
    const socket = FakeSocket.byBase.get("http://ship-a")!;
    socket.onclose?.({});
    socket.onopen?.({});
    await Bun.sleep(20);

    const revision = (await mgr.armoryManifest()).revision;
    expect(ships.get("http://ship-a")!.armorySyncs).toEqual([{ bridgeUrl: PUBLIC_URL, revision }]);
  });

  test("an adopted ship is pushed to", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [] }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
    ]);
    await store.createShip({ name: "ship-a", url: "http://ship-a" });
    const mgr = build(ships);
    await mgr.init();
    await settle(ships);

    await mgr.addShip("http://ship-b");
    await Bun.sleep(20);

    const revision = (await mgr.armoryManifest()).revision;
    expect(ships.get("http://ship-b")!.armorySyncs).toEqual([{ bridgeUrl: PUBLIC_URL, revision }]);
  });

  test("a ship whose sync fails does not make the push throw", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [], errorResponse: { status: 502, message: "bridge unreachable" } }],
      ["http://ship-b", { name: "ship-b", workspaces: [] }],
    ]);
    const mgr = await boot(ships);
    await settle(ships);

    expect(await mgr.pushArmory()).toBeUndefined();
    expect(ships.get("http://ship-b")!.armorySyncs).toHaveLength(1);
  });
});
