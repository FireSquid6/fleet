import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchAuthMode,
  fetchMe,
  login,
  logout,
  requestWsTicket,
  ticketedWsUrl,
} from "../src/data/auth";
import { makeBridgeClient, wsBridgeUrl, type BridgeClient } from "../src/data/client";
import { EdenFleetBridge } from "../src/data/eden";
import { clearToken, getToken, onUnauthorized, setToken } from "../src/data/token";

const USER = {
  id: "u1",
  username: "ada",
  email: "ada@fleet.test",
  role: "member" as const,
  createdAt: 1_700_000_000_000,
};

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
}

type Override = { status: number; body: unknown };

describe("bridge authentication from the browser", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: Recorded[];
  let overrides: Map<string, Override>;
  let ticketsIssued: number;
  let client: BridgeClient;

  const pathsCalled = (path: string) => requests.filter((r) => r.path === path);

  beforeEach(() => {
    requests = [];
    overrides = new Map();
    ticketsIssued = 0;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get("authorization"),
        });
        const override = overrides.get(url.pathname);
        if (override) return Response.json(override.body, { status: override.status });
        switch (url.pathname) {
          case "/auth/mode":
            return Response.json({ authRequired: true });
          case "/auth/login": {
            const body = (await request.json()) as { username: string; password: string };
            if (body.password !== "correct-horse") {
              return Response.json({ error: "invalid username or password" }, { status: 401 });
            }
            return Response.json({ token: "token-for-ada", user: USER });
          }
          case "/auth/logout":
            return Response.json({ ok: true });
          case "/auth/me":
            return Response.json(USER);
          case "/auth/ws-ticket":
            ticketsIssued += 1;
            return Response.json({ ticket: `ticket-${ticketsIssued}`, expiresAt: Date.now() + 30_000 });
          default:
            return Response.json([]);
        }
      },
    });
    client = makeBridgeClient(`http://localhost:${server.port}`);
    clearToken();
    onUnauthorized(null);
  });

  afterEach(() => {
    clearToken();
    onUnauthorized(null);
    server.stop(true);
  });

  test("a stored token rides on every bridge call, and nothing rides when there is none", async () => {
    const bridge = new EdenFleetBridge(client);

    await bridge.listWorkspaces();
    expect(requests.at(-1)!.authorization).toBeNull();

    setToken("token-for-ada");
    await bridge.listWorkspaces();
    expect(requests.at(-1)!.authorization).toBe("Bearer token-for-ada");

    clearToken();
    await bridge.listWorkspaces();
    expect(requests.at(-1)!.authorization).toBeNull();
  });

  test("login stores the token it was given and answers with the user", async () => {
    expect(await login("ada", "correct-horse", client)).toEqual(USER);
    expect(getToken()).toBe("token-for-ada");
  });

  test("a refused login surfaces the bridge's own wording and stores nothing", async () => {
    await expect(login("ada", "wrong", client)).rejects.toThrow("invalid username or password");
    expect(getToken()).toBeNull();
  });

  test("logout clears the token even when the bridge refuses the call", async () => {
    setToken("token-for-ada");
    overrides.set("/auth/logout", { status: 500, body: { error: "boom" } });

    await logout(client);

    expect(getToken()).toBeNull();
    expect(pathsCalled("/auth/logout")).toHaveLength(1);
  });

  test("logout clears the token even when the bridge cannot be reached", async () => {
    setToken("token-for-ada");
    await logout(makeBridgeClient("http://127.0.0.1:1"));
    expect(getToken()).toBeNull();
  });

  test("a 401 on any bridge call ends the session and reports it once", async () => {
    setToken("token-for-ada");
    let unauthorized = 0;
    onUnauthorized(() => {
      unauthorized += 1;
    });
    overrides.set("/workspaces", { status: 401, body: { error: "authentication required" } });

    await expect(new EdenFleetBridge(client).listWorkspaces()).rejects.toThrow("fleet-bridge request failed");

    expect(unauthorized).toBe(1);
    expect(getToken()).toBeNull();
  });

  test("fetchMe answers the user, or null when the bridge rejects the token", async () => {
    setToken("token-for-ada");
    expect(await fetchMe(client)).toEqual(USER);

    overrides.set("/auth/me", { status: 401, body: { error: "authentication required" } });
    expect(await fetchMe(client)).toBeNull();
  });

  test("fetchAuthMode reports whether the bridge wants credentials", async () => {
    expect(await fetchAuthMode(client)).toBe(true);

    overrides.set("/auth/mode", { status: 200, body: { authRequired: false } });
    expect(await fetchAuthMode(client)).toBe(false);
  });

  test("requestWsTicket returns the ticket the bridge minted", async () => {
    expect(await requestWsTicket(client)).toBe("ticket-1");
  });

  test("ticketedWsUrl carries a fresh ticket in the query, keeping any already there", async () => {
    setToken("token-for-ada");

    const events = new URL(await ticketedWsUrl("/events", client));
    expect(events.protocol).toBe("ws:");
    expect(events.pathname).toBe("/events");
    expect(events.searchParams.get("ticket")).toBe("ticket-1");

    const terminal = new URL(await ticketedWsUrl("/workspaces/repo/ws/terminal?takeover=true", client));
    expect(terminal.searchParams.get("takeover")).toBe("true");
    expect(terminal.searchParams.get("ticket")).toBe("ticket-2");
  });

  test("ticketedWsUrl asks for no ticket when nobody is signed in", async () => {
    expect(await ticketedWsUrl("/events", client)).toBe(wsBridgeUrl("/events"));
    expect(pathsCalled("/auth/ws-ticket")).toHaveLength(0);
  });

  test("ticketedWsUrl falls back to the bare URL when the ticket is refused", async () => {
    setToken("token-for-ada");
    overrides.set("/auth/ws-ticket", { status: 401, body: { error: "authentication required" } });

    expect(await ticketedWsUrl("/events", client)).toBe(wsBridgeUrl("/events"));
  });

  test("the event stream mints a second ticket for its reconnect rather than reusing one", async () => {
    setToken("token-for-ada");
    const sockets: FakeSocket[] = [];
    const bridge = new EdenFleetBridge(client, (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });

    const unsubscribe = bridge.subscribeWorkspaces(() => {});
    await until(() => sockets.length === 1);
    sockets[0]!.onclose?.();

    await until(() => sockets.length === 2, 4000);
    unsubscribe();

    expect(pathsCalled("/auth/ws-ticket")).toHaveLength(2);
    expect(ticketOf(sockets[0]!.url)).toBe("ticket-1");
    expect(ticketOf(sockets[1]!.url)).toBe("ticket-2");
  });

  test("unsubscribing while the ticket is in flight never opens a socket", async () => {
    setToken("token-for-ada");
    const sockets: FakeSocket[] = [];
    const bridge = new EdenFleetBridge(client, (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });

    bridge.subscribeWorkspaces(() => {})();
    await until(() => pathsCalled("/auth/ws-ticket").length === 1);
    await Bun.sleep(50);

    expect(sockets).toHaveLength(0);
  });
});

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
}

function ticketOf(url: string): string | null {
  return new URL(url).searchParams.get("ticket");
}

async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await Bun.sleep(10);
  }
}
