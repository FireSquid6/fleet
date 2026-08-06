import { describe, expect, test } from "bun:test";
import {
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_CODE,
} from "webterm/protocol";
import { attachCloseOutcome, openTerminalSocket } from "../src/attach";

describe("attach close reporting", () => {
  test("explains a refused attach and fails the command", () => {
    const outcome = attachCloseOutcome(TERMINAL_CONFLICT_CLOSE_CODE, "repo/ws-1");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("repo/ws-1");
    expect(outcome.message).toContain("already attached elsewhere");
  });

  test("explains being evicted by another client", () => {
    const outcome = attachCloseOutcome(TERMINAL_TAKEOVER_CLOSE_CODE, "repo/ws-1");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("took over repo/ws-1");
  });

  test("stays silent and succeeds on an ordinary close", () => {
    for (const code of [1000, 1001, 1006, INVALID_MESSAGE_CLOSE_CODE]) {
      expect(attachCloseOutcome(code, "repo/ws-1")).toEqual({ exitCode: 0 });
    }
  });
});

describe("attach terminal socket", () => {
  test("presents the ship token to the ship, and nothing when none is set", async () => {
    const seen: { path: string; authorization: string | null }[] = [];
    const ship = Bun.serve({
      port: 0,
      fetch(request, server) {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
        });
        return server.upgrade(request) ? undefined : new Response("expected an upgrade", { status: 400 });
      },
      websocket: { message() {} },
    });
    const url = `http://localhost:${ship.port}`;

    for (const token of ["ship-secret", undefined]) {
      const socket = openTerminalSocket(url, "repo 1", "ws-1", token);
      await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
      socket.close();
    }
    ship.stop(true);

    expect(seen).toEqual([
      { path: "/workspaces/repo%201/ws-1/terminal", authorization: "Bearer ship-secret" },
      { path: "/workspaces/repo%201/ws-1/terminal", authorization: null },
    ]);
  });
});
