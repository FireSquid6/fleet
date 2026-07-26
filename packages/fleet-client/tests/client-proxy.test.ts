import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  TERMINAL_TAKEOVER_QUERY,
  TERMINAL_TAKEOVER_QUERY_VALUE,
} from "webterm/protocol";
import { startClientServer, upgradeBridgeWebSocket } from "../src";

const opened = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
const closed = (socket: WebSocket) =>
  new Promise<CloseEvent>((resolve) => socket.addEventListener("close", (event) => resolve(event), { once: true }));
const nextMessage = (socket: WebSocket) =>
  new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));

describe("client terminal proxy", () => {
  test("closes and detaches an upstream socket when the browser upgrade fails", () => {
    let closed = 0;
    const upstream = {
      onopen: () => {},
      onmessage: () => {},
      onclose: () => {},
      onerror: () => {},
      close: () => closed++,
    } as unknown as WebSocket;
    const response = upgradeBridgeWebSocket(
      new Request("http://client/bridge/workspaces/repo/name/terminal"),
      { upgrade: () => false },
      "ws://bridge/workspaces/repo/name/terminal",
      () => upstream,
    );

    expect(response?.status).toBe(500);
    expect(closed).toBe(1);
    expect(upstream.onopen).toBeNull();
    expect(upstream.onmessage).toBeNull();
    expect(upstream.onclose).toBeNull();
    expect(upstream.onerror).toBeNull();
  });

  let upstream: Server<string>;
  let client: ReturnType<typeof startClientServer>;
  let url: string;

  beforeEach(() => {
    upstream = Bun.serve({
      port: 0,
      fetch(request, server) {
        const target = new URL(request.url);
        if (server.upgrade(request, { data: target.pathname + target.search })) return undefined;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          if (socket.data === "/events") socket.send('{"type":"sync"}');
        },
        message(socket, message) {
          const data = JSON.parse(String(message)).data;
          if (data === "bye") socket.close(4321, "bridge closed");
          else if (data === "binary") socket.send(new Uint8Array([1, 2, 3]));
          else if (data === "where") socket.send(socket.data);
        },
      },
    });
    client = startClientServer(`http://localhost:${upstream.port}`, 0);
    url = `ws://localhost:${client.port}/bridge/workspaces/repo/name/terminal`;
  });

  afterEach(() => {
    client.stop(true);
    upstream.stop(true);
  });

  test("preserves upstream close code and reason", async () => {
    const socket = new WebSocket(url);
    await opened(socket);
    const close = closed(socket);
    socket.send('{"type":"input","data":"bye"}');
    expect(await close).toMatchObject({ code: 4321, reason: "bridge closed" });
  });

  test("carries the terminal takeover query through to the bridge", async () => {
    const socket = new WebSocket(`${url}?${TERMINAL_TAKEOVER_QUERY}=${TERMINAL_TAKEOVER_QUERY_VALUE}`);
    await opened(socket);
    const message = nextMessage(socket);
    socket.send('{"type":"input","data":"where"}');
    expect(await message).toBe(
      `/workspaces/repo/name/terminal?${TERMINAL_TAKEOVER_QUERY}=${TERMINAL_TAKEOVER_QUERY_VALUE}`,
    );
    socket.close();
  });

  test("forwards a sync sent before the downstream socket opens", async () => {
    const socket = new WebSocket(`ws://localhost:${client.port}/bridge/events`);
    const message = nextMessage(socket);
    await opened(socket);
    expect(await message).toBe('{"type":"sync"}');
    socket.close();
  });

  test("rejects malformed and binary browser frames", async () => {
    for (const [frame, code, reason] of [
      ["{", INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON],
      [new Uint8Array([1]), BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON],
    ] as const) {
      const socket = new WebSocket(url);
      await opened(socket);
      const close = closed(socket);
      socket.send(frame);
      expect(await close).toMatchObject({ code, reason });
    }
  });

  test("rejects binary frames from the bridge without stringifying them", async () => {
    const socket = new WebSocket(url);
    await opened(socket);
    const close = closed(socket);
    socket.send('{"type":"input","data":"binary"}');
    const event = await close;
    expect({ code: event.code, reason: event.reason }).toEqual({
      code: BINARY_MESSAGE_CLOSE_CODE,
      reason: BINARY_MESSAGE_CLOSE_REASON,
    });
  });
});
