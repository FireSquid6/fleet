/**
 * events-ws.test.ts — exercises the ship's read-only `/events` WebSocket over a
 * real ephemeral-port server: snapshot-on-connect, fan-out broadcast to every
 * client, and continued delivery after one client disconnects.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FleetEvent } from "fleet-protocol";
import { createApp } from "../src/api";
import type { WorkspaceManager } from "../src/workspace-manager";
import { stubConfig } from "./helpers";

/** Stub manager whose `subscribe` feeds an `emit()` the test can call. */
function eventsStub() {
  const listeners = new Set<(e: FleetEvent) => void>();
  const manager = {
    subscribe: (fn: (e: FleetEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshotEvent: async () => ({ type: "sync", ship: "ship-a", at: "t", workspaces: [] }),
  } as unknown as WorkspaceManager;
  const emit = (e: FleetEvent) => {
    for (const fn of listeners) fn(e);
  };
  return { manager, emit };
}

const opened = (sock: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    sock.addEventListener("open", () => resolve(), { once: true });
    sock.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
const nextMessage = (sock: WebSocket) =>
  new Promise<FleetEvent>((resolve) =>
    sock.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), { once: true }),
  );

describe("ship /events WebSocket", () => {
  let app: ReturnType<typeof createApp>;
  let emit: (e: FleetEvent) => void;
  let url: string;

  beforeEach(() => {
    const stub = eventsStub();
    emit = stub.emit;
    app = createApp(stub.manager, stubConfig);
    app.listen(0);
    url = `ws://localhost:${app.server?.port}/events`;
  });
  afterEach(() => {
    app.server?.stop(true);
  });

  const created = (name: string): FleetEvent => ({
    type: "workspace.created",
    ship: "ship-a",
    at: "t",
    workspace: { repoName: "r", name, branch: "main", active: false },
  });

  test("sends a sync snapshot on connect, then broadcasts changes", async () => {
    const client = new WebSocket(url);
    await opened(client);

    const snapshot = await nextMessage(client);
    expect(snapshot.type).toBe("sync");

    const next = nextMessage(client);
    emit(created("one"));
    const change = await next;
    expect(change).toMatchObject({ type: "workspace.created", workspace: { name: "one" } });

    client.close();
  });

  test("fans out to multiple clients; one closing doesn't stop the other", async () => {
    const a = new WebSocket(url);
    const b = new WebSocket(url);
    await Promise.all([opened(a), opened(b)]);
    await Promise.all([nextMessage(a), nextMessage(b)]); // drain both snapshots

    // Both receive the first broadcast.
    const aFirst = nextMessage(a);
    const bFirst = nextMessage(b);
    emit(created("one"));
    expect((await aFirst).type).toBe("workspace.created");
    expect((await bFirst).type).toBe("workspace.created");

    // Close a; b keeps receiving.
    a.close();
    await new Promise((r) => setTimeout(r, 20)); // let the server observe the close
    const bSecond = nextMessage(b);
    emit(created("two"));
    expect(await bSecond).toMatchObject({ type: "workspace.created", workspace: { name: "two" } });

    b.close();
  });
});
