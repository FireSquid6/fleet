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
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  BUFFER_LIMIT_CLOSE_CODE,
  BUFFER_LIMIT_CLOSE_REASON,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  MAX_CLIENT_FRAME_BYTES,
} from "webterm/protocol";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { Store } from "../src/store/store";
import { FakeSocket, makeDeps, ws, type FakeShip } from "./helpers";

const opened = (sock: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    sock.addEventListener("open", () => resolve(), { once: true });
    sock.addEventListener("error", () => reject(new Error("client ws error")), { once: true });
  });
const nextMessage = (sock: WebSocket) =>
  new Promise<string>((resolve) => sock.addEventListener("message", (e) => resolve(String(e.data)), { once: true }));
const closed = (sock: WebSocket) =>
  new Promise<CloseEvent>((resolve) => sock.addEventListener("close", (event) => resolve(event), { once: true }));

describe("bridge terminal proxy", () => {
  let dir: string;
  let manager: FleetManager;
  let bridge: ReturnType<typeof createApp>;
  let upstream: Server<undefined>;
  let bridgeUrl: string;
  let ships: Map<string, FakeShip>;
  let upstreamClosed: Promise<{ code: number; reason: string }>;
  let upstreamPaths: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-term-"));
    FakeSocket.byBase.clear();

    // Stub upstream ship (plain Bun.serve — no elysia import needed in tests):
    // a WS echo on any path; "bye" closes the socket.
    let resolveUpstreamClose!: (value: { code: number; reason: string }) => void;
    upstreamClosed = new Promise((resolve) => (resolveUpstreamClose = resolve));
    upstreamPaths = [];
    upstream = Bun.serve({
      port: 0,
      fetch(req, server) {
        upstreamPaths.push(new URL(req.url).pathname);
        if (server.upgrade(req)) return undefined;
        return new Response("expected a websocket upgrade", { status: 400 });
      },
      websocket: {
        message(sock, message) {
          const data = JSON.parse(String(message)).data;
          if (data === "bye") sock.close(4321, "ship closed");
          else if (data === "binary") sock.send(new Uint8Array([1, 2, 3]));
          else sock.send(`echo:${message}`);
        },
        close(_socket, code, reason) {
          resolveUpstreamClose({ code, reason });
        },
      },
    });

    ships = new Map<string, FakeShip>([
      [`http://localhost:${upstream.port}`, { name: "ship-a", workspaces: [ws("repo1", "w1")] }],
    ]);

    const config = { dataDirectory: dir, port: 4800, name: "bridge" };
    const store = new Store(dir);
    await store.load();
    await store.createShip({ name: "ship-a", url: `http://localhost:${upstream.port}` });
    manager = new FleetManager(config, makeDeps(ships), { syncTimeoutMs: 50, store });
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
    client.send('{"type":"init","cols":80,"rows":24}'); // may be buffered until the upstream socket opens
    expect(await reply).toBe('echo:{"type":"init","cols":80,"rows":24}');

    client.close();
  });

  test("encodes terminal identifiers as exact upstream path segments", async () => {
    const repo = "repo ?#% 雪";
    const name = "work ?#% λ";
    FakeSocket.byBase.get(`http://localhost:${upstream.port}`)?.emit({
      type: "workspace.created",
      ship: "ship-a",
      at: "2026-01-01T00:00:00.000Z",
      workspace: ws(repo, name),
    });
    const client = new WebSocket(
      `${bridgeUrl}/workspaces/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/terminal`,
    );
    await opened(client);
    const reply = nextMessage(client);
    client.send('{"type":"init","cols":80,"rows":24}');
    await reply;

    expect(upstreamPaths.at(-1)).toBe(
      "/workspaces/repo%20%3F%23%25%20%E9%9B%AA/work%20%3F%23%25%20%CE%BB/terminal",
    );
    const close = closed(client);
    client.close();
    await close;
  });

  test("configures the Bun WebSocket payload limit through Elysia", () => {
    expect(bridge.config.websocket?.maxPayloadLength).toBe(MAX_CLIENT_FRAME_BYTES);
  });

  test("propagates an upstream close down to the client", async () => {
    const client = new WebSocket(`${bridgeUrl}/workspaces/repo1/w1/terminal`);
    await opened(client);

    const onClose = closed(client);
    client.send('{"type":"input","data":"bye"}');
    expect(await onClose).toMatchObject({ code: 4321, reason: "ship closed" });
  });

  test("propagates a client close up to the ship", async () => {
    const client = new WebSocket(`${bridgeUrl}/workspaces/repo1/w1/terminal`);
    await opened(client);
    const reply = nextMessage(client);
    client.send('{"type":"init","cols":80,"rows":24}');
    await reply;
    client.close(4322, "browser closed");
    // Bun 1.3 exposes the browser's code to Elysia but reports an empty reason.
    expect(await upstreamClosed).toEqual({ code: 4322, reason: "" });
  });

  test("rejects malformed and binary client frames", async () => {
    for (const [frame, code, reason] of [
      ["{", INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON],
      [new Uint8Array([1]), BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON],
    ] as const) {
      const client = new WebSocket(`${bridgeUrl}/workspaces/repo1/w1/terminal`);
      await opened(client);
      const close = closed(client);
      client.send(frame);
      expect(await close).toMatchObject({ code, reason });
    }
  });

  test("rejects binary frames from the ship without stringifying them", async () => {
    const client = new WebSocket(`${bridgeUrl}/workspaces/repo1/w1/terminal`);
    await opened(client);
    const close = closed(client);
    client.send('{"type":"input","data":"binary"}');
    const event = await close;
    expect({ code: event.code, reason: event.reason }).toEqual({
      code: BINARY_MESSAGE_CLOSE_CODE,
      reason: BINARY_MESSAGE_CLOSE_REASON,
    });
  });

  test("caps aggregate frames while the upstream connection is pending", async () => {
    const stagnant = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    await manager.removeShip("ship-a");
    const stagnantUrl = `http://127.0.0.1:${stagnant.port}`;
    ships.set(stagnantUrl, { name: "stagnant", workspaces: [ws("repo1", "w1")] });
    await manager.addShip(stagnantUrl);

    const client = new WebSocket(`${bridgeUrl}/workspaces/repo1/w1/terminal`);
    await opened(client);
    const close = closed(client);
    const escapedFrame = JSON.stringify({ type: "input", data: "\0".repeat(50_000) });
    client.send(escapedFrame);
    expect(await close).toMatchObject({ code: BUFFER_LIMIT_CLOSE_CODE, reason: BUFFER_LIMIT_CLOSE_REASON });
    stagnant.stop(true);
  });

  test("closes with an exit frame when the workspace is unknown", async () => {
    const client = new WebSocket(`${bridgeUrl}/workspaces/ghost/none/terminal`);
    const frame = await nextMessage(client);
    expect(JSON.parse(frame)).toEqual({ type: "exit", code: 1 });
    await closed(client);
  });
});
