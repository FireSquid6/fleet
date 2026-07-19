/**
 * ship-connection.test.ts — direct unit tests for the transport layer:
 * `toWsUrl`, `waitForSync` (resolve + timeout), event application to the
 * connection's own workspace map, and status transitions. A hand-driven
 * `ManualSocket` lets each test control open/message/close timing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ShipConnection, toWsUrl, type SocketLike } from "../src/ship-connection";
import type { ShipStatus } from "../src/types";

class ManualSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
}

const sync = (ship: string, workspaces: Array<{ repoName: string; name: string }>) => ({
  type: "sync",
  ship,
  at: "2026-01-01T00:00:00.000Z",
  workspaces: workspaces.map((w) => ({ ...w, branch: "main", active: false })),
});

const change = (type: string, ship: string, repoName: string, name: string) => ({
  type,
  ship,
  at: "2026-01-01T00:00:00.000Z",
  workspace: { repoName, name, branch: "main", active: false },
});

describe("toWsUrl", () => {
  test("maps http→ws and https→wss and sets the path", () => {
    expect(toWsUrl("http://host:4700", "/events")).toBe("ws://host:4700/events");
    expect(toWsUrl("https://host:4700", "/events")).toBe("wss://host:4700/events");
    expect(toWsUrl("http://h:1", "/workspaces/r/n/terminal")).toBe("ws://h:1/workspaces/r/n/terminal");
  });
});

describe("ShipConnection", () => {
  let conn: ShipConnection | undefined;
  let socket: ManualSocket;

  function connect(name?: string): ShipConnection {
    socket = new ManualSocket();
    conn = new ShipConnection({
      url: "http://ship",
      name,
      deps: { createSocket: () => socket, createClient: () => ({}) as never },
    });
    return conn;
  }
  afterEach(() => {
    conn?.close();
    conn = undefined;
  });

  test("waitForSync resolves on the first sync event", async () => {
    const c = connect();
    c.connect();
    const p = c.waitForSync(1000);
    socket.onmessage?.({ data: JSON.stringify(sync("ship-a", [{ repoName: "r", name: "n" }])) });
    const event = await p;
    expect(event.ship).toBe("ship-a");
    expect(c.name).toBe("ship-a");
  });

  test("waitForSync rejects on timeout", async () => {
    const c = connect();
    c.connect();
    await expect(c.waitForSync(20)).rejects.toThrow(/timed out/);
  });

  test("applies sync/created/removed to its own workspace map", async () => {
    const c = connect();
    c.connect();

    socket.onmessage?.({ data: JSON.stringify(sync("ship-a", [{ repoName: "r", name: "one" }])) });
    expect([...c.workspaces.keys()]).toEqual(["r/one"]);

    socket.onmessage?.({ data: JSON.stringify(change("workspace.created", "ship-a", "r", "two")) });
    expect([...c.workspaces.keys()].sort()).toEqual(["r/one", "r/two"]);

    socket.onmessage?.({ data: JSON.stringify(change("workspace.removed", "ship-a", "r", "one")) });
    expect([...c.workspaces.keys()]).toEqual(["r/two"]);

    // A garbage frame is ignored, not fatal.
    socket.onmessage?.({ data: "not json" });
    expect([...c.workspaces.keys()]).toEqual(["r/two"]);
  });

  test("status flips online on open and offline on close, notifying handlers", async () => {
    const c = connect();
    const seen: ShipStatus[] = [];
    c.setHandlers({ onEvent: () => {}, onStatusChange: (_c, s) => seen.push(s) });
    c.connect();

    expect(c.status).toBe("offline");
    socket.onopen?.({});
    expect(c.status).toBe("online");
    socket.onclose?.({});
    expect(c.status).toBe("offline");

    expect(seen).toEqual(["online", "offline"]);
  });
});
