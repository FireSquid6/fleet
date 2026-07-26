import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  MAX_CLIENT_FRAME_BYTES,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_CONFLICT_CLOSE_REASON,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_REASON,
  TERMINAL_TAKEOVER_QUERY,
  TERMINAL_TAKEOVER_QUERY_VALUE,
} from "webterm/protocol";
import type { ServerMsg } from "webterm/protocol";
import { createApp } from "../src/api";
import {
  TERMINAL_INIT_TIMEOUT_CLOSE_CODE,
  TERMINAL_INIT_TIMEOUT_CLOSE_REASON,
} from "../src/api/workspaces";
import { WORKSPACE_TMUX_NAMESPACE, workspaceSessionName } from "../src/workspace-session";
import { stubConfig, stubManager } from "./helpers";

const opened = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
const closed = (socket: WebSocket) =>
  new Promise<CloseEvent>((resolve) => socket.addEventListener("close", (event) => resolve(event), { once: true }));

describe("ship terminal protocol", () => {
  let app: ReturnType<typeof createApp>;
  let url: string;
  let handled: unknown[];
  let stops: number;
  let creates: number;
  let argvs: string[][];
  let sendOnCreate: ServerMsg | undefined;
  let createTerminal: Parameters<typeof createApp>[2];

  beforeEach(() => {
    handled = [];
    stops = 0;
    creates = 0;
    argvs = [];
    sendOnCreate = undefined;
    createTerminal = (options) => {
      creates++;
      argvs.push([...options.argv]);
      if (sendOnCreate) options.send(sendOnCreate);
      return {
        handle: (message) => handled.push(message),
        stop: () => stops++,
      };
    };
    app = createApp(stubManager(), stubConfig, createTerminal);
    app.listen(0);
    url = `ws://localhost:${app.server?.port}/workspaces/repo/name/terminal`;
  });

  test("configures the Bun WebSocket payload limit through Elysia", () => {
    expect(app.config.websocket?.maxPayloadLength).toBe(MAX_CLIENT_FRAME_BYTES);
  });

  test("attaches formerly colliding workspaces to their own session targets", async () => {
    const first = new WebSocket(`ws://localhost:${app.server?.port}/workspaces/a.b/workspace/terminal`);
    const second = new WebSocket(`ws://localhost:${app.server?.port}/workspaces/a-b/workspace/terminal`);
    await Promise.all([opened(first), opened(second)]);

    expect(argvs).toHaveLength(2);
    expect(argvs).toContainEqual([
      "tmux", "-L", WORKSPACE_TMUX_NAMESPACE, "attach", "-t", workspaceSessionName("a.b", "workspace"),
    ]);
    expect(argvs).toContainEqual([
      "tmux", "-L", WORKSPACE_TMUX_NAMESPACE, "attach", "-t", workspaceSessionName("a-b", "workspace"),
    ]);

    const closes = [closed(first), closed(second)];
    first.close();
    second.close();
    await Promise.all(closes);
  });

  test("closes and releases immediately when the terminal exits", async () => {
    sendOnCreate = { type: "exit", code: 17 };
    const socket = new WebSocket(url);
    const message = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    );
    const close = closed(socket);
    await opened(socket);
    expect(JSON.parse(await message)).toEqual({ type: "exit", code: 17 });
    await close;
    expect({ creates, stops }).toEqual({ creates: 1, stops: 1 });

    sendOnCreate = undefined;
    const replacement = new WebSocket(url);
    await opened(replacement);
    expect(creates).toBe(2);
    const replacementClose = closed(replacement);
    replacement.close();
    await replacementClose;
  });

  afterEach(() => {
    app.server?.stop(true);
  });

  test("accepts one init before input and resize", async () => {
    const socket = new WebSocket(url);
    await opened(socket);
    socket.send('{"type":"init","cols":80,"rows":24}');
    socket.send('{"type":"input","data":"x"}');
    socket.send('{"type":"resize","cols":81,"rows":25}');
    await Bun.sleep(20);
    expect(handled).toEqual([
      { type: "init", cols: 80, rows: 24 },
      { type: "input", data: "x" },
      { type: "resize", cols: 81, rows: 25 },
    ]);
    const close = closed(socket);
    socket.close();
    await close;
  });

  test("times out a missing init and releases the workspace for reconnect", async () => {
    app.server?.stop(true);
    app = createApp(stubManager(), stubConfig, createTerminal, 20);
    app.listen(0);
    url = `ws://localhost:${app.server?.port}/workspaces/repo/name/terminal`;

    const socket = new WebSocket(url);
    const close = closed(socket);
    await opened(socket);
    expect(await close).toMatchObject({
      code: TERMINAL_INIT_TIMEOUT_CLOSE_CODE,
      reason: TERMINAL_INIT_TIMEOUT_CLOSE_REASON,
    });
    expect(stops).toBe(1);

    const replacement = new WebSocket(url);
    await opened(replacement);
    replacement.send('{"type":"init","cols":80,"rows":24}');
    await Bun.sleep(30);
    expect(replacement.readyState).toBe(WebSocket.OPEN);
    const replacementClose = closed(replacement);
    replacement.close();
    await replacementClose;
    await Bun.sleep(10);
    expect(stops).toBe(2);
  });

  for (const [name, frames] of [
    ["input before init", ['{"type":"input","data":"x"}']],
    ["duplicate init", ['{"type":"init","cols":80,"rows":24}', '{"type":"init","cols":80,"rows":24}']],
    ["malformed JSON", ["{"]],
    ["invalid schema", ['{"type":"init","cols":0,"rows":24}']],
  ] as const) {
    test(`closes and releases the terminal on ${name}`, async () => {
      const socket = new WebSocket(url);
      await opened(socket);
      const close = closed(socket);
      for (const frame of frames) socket.send(frame);
      expect(await close).toMatchObject({ code: INVALID_MESSAGE_CLOSE_CODE, reason: INVALID_MESSAGE_CLOSE_REASON });
      expect(stops).toBe(1);

      const replacement = new WebSocket(url);
      await opened(replacement);
      const replacementClose = closed(replacement);
      replacement.close();
      await replacementClose;
    });
  }

  describe("single-connection guard", () => {
    const takeoverUrl = () => `${url}?${TERMINAL_TAKEOVER_QUERY}=${TERMINAL_TAKEOVER_QUERY_VALUE}`;

    test("refuses a second connection without disturbing the incumbent", async () => {
      const first = new WebSocket(url);
      await opened(first);
      first.send('{"type":"init","cols":80,"rows":24}');

      const second = new WebSocket(url);
      const refused = closed(second);
      expect(await refused).toMatchObject({
        code: TERMINAL_CONFLICT_CLOSE_CODE,
        reason: TERMINAL_CONFLICT_CLOSE_REASON,
      });
      await Bun.sleep(20);
      expect({ creates, stops }).toEqual({ creates: 1, stops: 0 });
      expect(first.readyState).toBe(WebSocket.OPEN);

      first.send('{"type":"input","data":"still here"}');
      await Bun.sleep(20);
      expect(handled).toContainEqual({ type: "input", data: "still here" });

      const close = closed(first);
      first.close();
      await close;
    });

    test("evicts the incumbent when a takeover is requested", async () => {
      const first = new WebSocket(url);
      await opened(first);
      first.send('{"type":"init","cols":80,"rows":24}');
      await Bun.sleep(20);

      const evicted = closed(first);
      const second = new WebSocket(takeoverUrl());
      await opened(second);
      expect(await evicted).toMatchObject({
        code: TERMINAL_TAKEOVER_CLOSE_CODE,
        reason: TERMINAL_TAKEOVER_CLOSE_REASON,
      });
      await Bun.sleep(20);
      expect({ creates, stops }).toEqual({ creates: 2, stops: 1 });

      second.send('{"type":"init","cols":100,"rows":40}');
      await Bun.sleep(20);
      expect(handled).toContainEqual({ type: "init", cols: 100, rows: 40 });
      expect(second.readyState).toBe(WebSocket.OPEN);

      const close = closed(second);
      second.close();
      await close;
    });

    test("leaves exactly one owner behind after a takeover", async () => {
      const first = new WebSocket(url);
      await opened(first);
      const evicted = closed(first);
      const second = new WebSocket(takeoverUrl());
      await opened(second);
      await evicted;
      // The evicted socket's own close event must not release the guard the
      // taker now holds.
      await Bun.sleep(20);

      const third = new WebSocket(url);
      expect(await closed(third)).toMatchObject({ code: TERMINAL_CONFLICT_CLOSE_CODE });
      expect(second.readyState).toBe(WebSocket.OPEN);

      const released = closed(second);
      second.close();
      await released;
      await Bun.sleep(20);

      const fourth = new WebSocket(url);
      await opened(fourth);
      const close = closed(fourth);
      fourth.close();
      await close;
    });

    test("connects normally when a takeover finds no incumbent", async () => {
      const socket = new WebSocket(takeoverUrl());
      await opened(socket);
      socket.send('{"type":"init","cols":80,"rows":24}');
      await Bun.sleep(20);
      expect({ creates, stops }).toEqual({ creates: 1, stops: 0 });
      expect(handled).toEqual([{ type: "init", cols: 80, rows: 24 }]);
      const close = closed(socket);
      socket.close();
      await close;
    });
  });

  test("uses the binary close code and fixed reason", async () => {
    const socket = new WebSocket(url);
    await opened(socket);
    const close = closed(socket);
    socket.send(new Uint8Array([1, 2, 3]));
    expect(await close).toMatchObject({ code: BINARY_MESSAGE_CLOSE_CODE, reason: BINARY_MESSAGE_CLOSE_REASON });
    expect(stops).toBe(1);
  });
});
