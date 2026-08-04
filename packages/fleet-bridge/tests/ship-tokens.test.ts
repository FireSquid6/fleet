import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import type { AuthService } from "../src/auth/auth-service";
import { FleetManager } from "../src/fleet-manager";
import { Store } from "../src/store/store";
import { FakeSocket, makeDeps, makeTestAuth, seedUser, ws, type FakeShip } from "./helpers";

describe("ship credentials", () => {
  let dir: string;
  let store: Store;
  let auth: AuthService;
  let manager: FleetManager | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-tokens-"));
    FakeSocket.byBase.clear();
    store = new Store(dir);
    await store.load();
    auth = makeTestAuth();
  });

  afterEach(async () => {
    manager?.shutdown();
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function build(ships: Map<string, FakeShip>): FleetManager {
    manager = new FleetManager({ dataDirectory: dir, port: 4800, name: "bridge" }, makeDeps(ships), {
      syncTimeoutMs: 1000,
      store,
      credentials: auth,
    });
    return manager;
  }

  test("presents a persisted ship's bridgeToken on its socket and its calls", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await store.createShip({ name: "ship-a", url: "http://ship-a" });
    const { bridgeToken } = auth.createShipCredentials("ship-a");

    const mgr = build(ships);
    await mgr.init();
    await mgr.listWorkspaces();

    const ship = ships.get("http://ship-a")!;
    expect(ship.socketAuthorizations).toEqual([`Bearer ${bridgeToken}`]);
    expect(ship.authorizations?.length).toBeGreaterThan(0);
    expect(new Set(ship.authorizations)).toEqual(new Set([`Bearer ${bridgeToken}`]));
  });

  test("presents nothing for a ship with no credentials", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await store.createShip({ name: "ship-a", url: "http://ship-a" });

    const mgr = build(ships);
    await mgr.init();
    await mgr.listWorkspaces();

    const ship = ships.get("http://ship-a")!;
    expect(ship.socketAuthorizations).toEqual([null]);
    expect(new Set(ship.authorizations)).toEqual(new Set([null]));
  });

  test("addShip presents the offered bridgeToken while probing and stores both halves", async () => {
    const ships = new Map<string, FakeShip>([["http://ship-b", { name: "ship-b", workspaces: [] }]]);
    const mgr = build(ships);
    await mgr.init();

    await mgr.addShip("http://ship-b", { shipToken: "ship-secret", bridgeToken: "bridge-secret" });

    expect(ships.get("http://ship-b")!.socketAuthorizations).toEqual(["Bearer bridge-secret"]);
    expect(auth.bridgeTokenFor("ship-b")).toBe("bridge-secret");
    expect(auth.authenticate("Bearer ship-secret")).toEqual({ kind: "ship", ship: "ship-b" });
  });

  test("addShip stores nothing when no credentials are offered", async () => {
    const ships = new Map<string, FakeShip>([["http://ship-b", { name: "ship-b", workspaces: [] }]]);
    const mgr = build(ships);
    await mgr.init();

    await mgr.addShip("http://ship-b");

    expect(auth.bridgeTokenFor("ship-b")).toBeUndefined();
  });

  test("addShip rejects one half of a credential pair", async () => {
    const ships = new Map<string, FakeShip>([["http://ship-b", { name: "ship-b", workspaces: [] }]]);
    const mgr = build(ships);
    await mgr.init();

    await expect(mgr.addShip("http://ship-b", { shipToken: "only-one" })).rejects.toMatchObject({ status: 400 });
    await expect(mgr.addShip("http://ship-b", { bridgeToken: "only-one" })).rejects.toMatchObject({ status: 400 });
    expect(mgr.listShips()).toHaveLength(0);
  });

  test("removeShip deletes the ship's credentials", async () => {
    const ships = new Map<string, FakeShip>([["http://ship-a", { name: "ship-a", workspaces: [] }]]);
    await store.createShip({ name: "ship-a", url: "http://ship-a" });
    const { shipToken } = auth.createShipCredentials("ship-a");

    const mgr = build(ships);
    await mgr.init();
    await mgr.removeShip("ship-a");

    expect(auth.bridgeTokenFor("ship-a")).toBeUndefined();
    expect(auth.authenticate(`Bearer ${shipToken}`)).toBeNull();
  });

  test("terminalTarget carries the bridgeToken as a header", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a:3001", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await store.createShip({ name: "ship-a", url: "http://ship-a:3001" });
    const { bridgeToken } = auth.createShipCredentials("ship-a");

    const mgr = build(ships);
    await mgr.init();

    expect(mgr.terminalTarget("repo1", "one")).toEqual({
      url: "ws://ship-a:3001/workspaces/repo1/one/terminal",
      headers: { authorization: `Bearer ${bridgeToken}` },
    });
  });

  test("terminalTarget omits the header for a ship with no credentials", async () => {
    const ships = new Map<string, FakeShip>([
      ["http://ship-a:3001", { name: "ship-a", workspaces: [ws("repo1", "one")] }],
    ]);
    await store.createShip({ name: "ship-a", url: "http://ship-a:3001" });

    const mgr = build(ships);
    await mgr.init();

    expect(mgr.terminalTarget("repo1", "one").headers).toBeUndefined();
  });

  test("the terminal proxy presents the bridgeToken to the ship", async () => {
    const seen: (string | null)[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(request, server) {
        seen.push(request.headers.get("authorization"));
        return server.upgrade(request) ? undefined : new Response("expected an upgrade", { status: 400 });
      },
      websocket: { message() {} },
    });
    const url = `http://localhost:${upstream.port}`;
    const ships = new Map<string, FakeShip>([[url, { name: "ship-a", workspaces: [ws("repo1", "one")] }]]);
    await store.createShip({ name: "ship-a", url });
    const { bridgeToken } = auth.createShipCredentials("ship-a");

    const mgr = build(ships);
    await mgr.init();
    const app = createApp(mgr, auth);
    app.listen(0);
    const ticket = auth.issueWsTicket({ kind: "user", id: "t", username: "ada", role: "admin" }).ticket;

    const client = new WebSocket(
      `ws://localhost:${app.server?.port}/workspaces/repo1/one/terminal?ticket=${ticket}`,
    );
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve(), { once: true }));
    client.send('{"type":"init","cols":80,"rows":24}');
    await Bun.sleep(50);
    client.close();
    app.server?.stop(true);
    upstream.stop(true);

    expect(seen).toEqual([`Bearer ${bridgeToken}`]);
  });

  test("POST /ships hands the offered tokens to the manager", async () => {
    const ships = new Map<string, FakeShip>([["http://ship-b", { name: "ship-b", workspaces: [] }]]);
    const mgr = build(ships);
    await mgr.init();
    const app = createApp(mgr, auth);
    const { authorization } = await seedUser(auth, { username: "ada", role: "admin" });

    const response = await app.handle(
      new Request("http://bridge/ships", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          url: "http://ship-b",
          shipToken: "ship-secret",
          bridgeToken: "bridge-secret",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(auth.bridgeTokenFor("ship-b")).toBe("bridge-secret");
    expect(ships.get("http://ship-b")!.socketAuthorizations).toEqual(["Bearer bridge-secret"]);
  });
});
