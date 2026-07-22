import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FleetManager } from "../src/fleet-manager";
import type { BridgeWorkspaceEvent, BridgeWorkspaceSummary } from "../src/types";
import { eventsPlugin } from "../src/api/events";

function managerStub() {
  const listeners = new Set<(event: BridgeWorkspaceEvent) => void>();
  const workspace: BridgeWorkspaceSummary = {
    repoName: "repo",
    name: "one",
    branch: "main",
    active: true,
    agent: null,
    ship: "ship-a",
  };
  const manager = {
    subscribe(listener: (event: BridgeWorkspaceEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    workspaceSnapshot: () => [workspace],
  } as unknown as FleetManager;
  return {
    manager,
    workspace,
    emit(event: BridgeWorkspaceEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

const opened = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
});

const nextMessage = (socket: WebSocket) => new Promise<BridgeWorkspaceEvent>((resolve) => {
  socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
});

describe("bridge /events WebSocket", () => {
  let app: ReturnType<typeof eventsPlugin>;
  let stub: ReturnType<typeof managerStub>;
  let url: string;

  beforeEach(() => {
    stub = managerStub();
    app = eventsPlugin(stub.manager);
    app.listen(0);
    url = `ws://localhost:${app.server?.port}/events`;
  });

  afterEach(() => app.server?.stop(true));

  test("sends an aggregate snapshot and streams status changes", async () => {
    const socket = new WebSocket(url);
    await opened(socket);
    expect(await nextMessage(socket)).toMatchObject({
      type: "sync",
      workspaces: [{ name: "one", ship: "ship-a", agent: null }],
    });

    const status = {
      state: "verifying" as const,
      description: "Running bridge tests",
      model: "sonnet",
      provider: "anthropic",
      harness: "opencode",
    };
    const next = nextMessage(socket);
    stub.emit({
      type: "workspace.agent_status_changed",
      at: "t",
      workspace: { ...stub.workspace, agent: status },
    });
    expect(await next).toMatchObject({
      type: "workspace.agent_status_changed",
      workspace: { ship: "ship-a", agent: status },
    });
    socket.close();
  });
});
