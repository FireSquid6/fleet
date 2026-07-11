/**
 * terminal-proxy.test.ts — exercises the bridge's `/workspaces/:repo/:name/terminal`
 * WebSocket proxy end-to-end against a real (stub) upstream ship. Both the bridge
 * and the stub listen on ephemeral ports; a real browser-style `WebSocket` drives
 * the bridge. Covers: bidirectional forwarding (incl. buffered-before-open frames),
 * upstream-close propagation, and the unknown-workspace exit path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { getDb } from "../src/db";
import { ShipService } from "../src/services/ship-service";
import { FakeSocket, makeDeps, ws, type FakeShip } from "./helpers";

const opened = (sock: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    sock.addEventListener("open", () => resolve(), { once: true });
    sock.addEventListener("error", () => reject(new Error("client ws error")), { once: true });
  });
const nextMessage = (sock: WebSocket) =>
  new Promise<string>((resolve) => sock.addEventListener("message", (e) => resolve(String(e.data)), { once: true }));
const closed = (sock: WebSocket) =>
  new Promise<void>((resolve) => sock.addEventListener("close", () => resolve(), { once: true }));

describe("bridge terminal proxy", () => {
  let dir: string;
  let manager: FleetManager;
  let bridge: ReturnType<typeof createApp>;
  let upstream: Server<undefined>;
  let bridgeUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-term-"));
    FakeSocket.byBase.clear();

    // Stub upstream ship (plain Bun.serve — no elysia import needed in tests):
    // a WS echo on any path; "bye" closes the socket.
    upstream = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("expected a websocket upgrade", { status: 400 });
      },
      websocket: {
        message(sock, message) {
          if (message === "bye") sock.close();
          else sock.send(`echo:${message}`);
        },
      },
    });

    const ships = new Map<string, FakeShip>([
      [`http://localhost:${upstream.port}`, { name: "ship-a", workspaces: [ws("repo1", "w1")] }],
    ]);

    const config = { dataDirectory: dir, port: 4800, name: "bridge", ephemeralDb: true };
    const db = getDb(config);
    await new ShipService(db).createShip({ name: "ship-a", url: `http://localhost:${upstream.port}` });
    manager = new FleetManager(config, makeDeps(ships), { syncTimeoutMs: 50, db });
    await manager.init();

    bridge = createApp(manager, config);
    bridge.listen(0);
    bridgeUrl = `ws://localhost:${bridge.server?.port}`;
  });

  afterEach(async () => {
    manager.shutdown();
    // Force-stop the underlying Bun servers directly — Elysia's async stop() can
    // hang waiting on the proxied sockets to drain.
    bridge.server?.stop(true);
    upstream.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("forwards frames both directions through the owning ship", async () => {
    const client = new WebSocket(`${bridgeUrl}/workspaces/repo1/w1/terminal`);
    await opened(client);

    const reply = nextMessage(client);
    client.send("hello"); // may be buffered until the upstream socket opens
    expect(await reply).toBe("echo:hello");

    client.close();
  });

  test("propagates an upstream close down to the client", async () => {
    const client = new WebSocket(`${bridgeUrl}/workspaces/repo1/w1/terminal`);
    await opened(client);

    const onClose = closed(client);
    client.send("bye"); // upstream closes on this frame
    await onClose; // resolving means the close propagated through the bridge
  });

  test("closes with an exit frame when the workspace is unknown", async () => {
    const client = new WebSocket(`${bridgeUrl}/workspaces/ghost/none/terminal`);
    const frame = await nextMessage(client);
    expect(JSON.parse(frame)).toEqual({ type: "exit", code: 1 });
    await closed(client);
  });
});
