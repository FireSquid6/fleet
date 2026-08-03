import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSummary } from "fleet-protocol";
import { startBridge } from "../src/index";
import { Store } from "../src/store/store";
import { ws } from "./helpers";

interface Pull {
  ok: boolean;
  detail: string;
}

/**
 * A ship that answers the bridge over real HTTP + WebSocket, and reports back
 * whether it could reach `GET <bridgeUrl>/armory` at the moments it would in
 * production: when its event socket opens, and when the bridge pushes it a sync.
 */
function startFakeShip(name: string, workspaces: WorkspaceSummary[] = []) {
  const onConnect: Pull[] = [];
  const onArmoryPush: Pull[] = [];
  let bridgeUrl: string | undefined;

  const pull = async (into: Pull[], url: string | undefined): Promise<void> => {
    if (!url) {
      into.push({ ok: false, detail: "no bridge url known yet" });
      return;
    }
    try {
      const response = await fetch(`${url}/armory`);
      into.push({ ok: response.ok, detail: `status ${response.status}` });
    } catch (error) {
      into.push({ ok: false, detail: (error as Error).message });
    }
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request, self) {
      const { pathname } = new URL(request.url);
      if (pathname === "/events") {
        return self.upgrade(request) ? undefined : new Response("expected a websocket", { status: 400 });
      }
      if (pathname === "/armory/sync" && request.method === "POST") {
        const body = (await request.json()) as { bridgeUrl: string; revision: string };
        await pull(onArmoryPush, body.bridgeUrl);
        return Response.json({ revision: body.revision });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "sync", ship: name, at: new Date().toISOString(), workspaces }));
        void pull(onConnect, bridgeUrl);
      },
      message() {},
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    onConnect,
    onArmoryPush,
    expectBridgeAt(url: string) {
      bridgeUrl = url;
    },
    stop: () => server.stop(true),
  };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = server;
  await server.stop(true);
  if (port === undefined) throw new Error("could not reserve a port");
  return port;
}

describe("startBridge", () => {
  let dir: string;
  let ships: ReturnType<typeof startFakeShip>[] = [];
  let stopBridge: (() => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-start-"));
    await mkdir(join(dir, "armory", "skills", "one"), { recursive: true });
    await writeFile(join(dir, "armory", "skills", "one", "SKILL.md"), "# one\n");
  });

  afterEach(async () => {
    stopBridge?.();
    stopBridge = undefined;
    await Promise.all(ships.map((each) => each.stop()));
    ships = [];
    await rm(dir, { recursive: true, force: true });
  });

  /** A ship on the persisted roster, torn down with the test. */
  async function roster(name: string, workspaces?: WorkspaceSummary[]) {
    const each = startFakeShip(name, workspaces);
    ships.push(each);
    const store = new Store(dir);
    await store.load();
    await store.createShip({ name, url: each.url });
    return each;
  }

  test("a ship already online when the bridge starts can reach the armory it is pushed", async () => {
    const ship = await roster("ship-a");

    const port = await freePort();
    const publicUrl = `http://localhost:${port}`;
    ship.expectBridgeAt(publicUrl);

    const { manager, watcher } = await startBridge({ dataDirectory: dir, port, name: "bridge", publicUrl });
    stopBridge = () => {
      watcher.close();
      manager.shutdown();
    };
    await Bun.sleep(100);

    // The connect probe runs inside `init`, so it pins the ordering: listen must
    // already have happened by the time the roster comes online.
    expect(ship.onConnect).toEqual([{ ok: true, detail: "status 200" }]);
    expect(ship.onArmoryPush.length).toBeGreaterThan(0);
    expect(ship.onArmoryPush.every((attempt) => attempt.ok)).toBe(true);
  });

  test("a failed init releases the port instead of leaving it bound", async () => {
    const duplicate = [ws("acme", "dupe")];
    await roster("ship-a", duplicate);
    await roster("ship-b", duplicate);

    const port = await freePort();
    const publicUrl = `http://localhost:${port}`;

    await expect(
      startBridge({ dataDirectory: dir, port, name: "bridge", publicUrl }),
    ).rejects.toThrow(/duplicate workspaces/);

    await expect(fetch(`${publicUrl}/ships`)).rejects.toThrow();

    const reclaimed = Bun.serve({ port, fetch: () => new Response("reclaimed") });
    try {
      expect(await fetch(publicUrl).then((response) => response.text())).toBe("reclaimed");
    } finally {
      await reclaimed.stop(true);
    }
  });
});
