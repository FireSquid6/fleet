/**
 * helpers.ts — shared fakes for the bridge test suite.
 *
 * A `FleetManager` is built against a fake `SocketLike` (`/events`) and a fake
 * Eden client, so the dedupe/routing/error logic is exercised with no real ships.
 * `FakeSocket.byBase` lets a test grab a ship's live socket to close it (force
 * offline) or `emit()` a post-init event; a ship can also be configured to never
 * sync, to return an Eden error, or to throw (network failure).
 */

import type { FleetEvent, SystemResources, WorkspaceSummary } from "fleet-protocol";
import type { ShipConnectionDeps, SocketLike } from "../src/ship-connection";

/** A ship the fakes pretend exists at a given base URL. */
export interface FakeShip {
  name: string;
  workspaces: WorkspaceSummary[];
  createResponse?: unknown;
  createCalls?: number;
  createGate?: { entered: () => void; wait: Promise<void> };
  createThenThrows?: boolean;
  statusResponse?: unknown;
  workspaceSnapshot?: unknown;
  /** Socket opens but never sends a `sync` (for waitForSync timeout tests). */
  neverSync?: boolean;
  /** All Eden calls resolve to this error `{status, value:{error}}`. */
  errorResponse?: { status: number; message: string };
  /** All Eden calls throw (simulated network failure). */
  throws?: boolean;
}

/** Reduce a `ws://host/events` (or `/…/terminal`) url back to its `http://host` base. */
export function httpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return u.origin;
}

/** A fake `/events` socket: emits one `sync` on connect (unless absent/neverSync). */
export class FakeSocket implements SocketLike {
  /** Latest socket opened per ship base url. */
  static readonly byBase = new Map<string, FakeSocket>();

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private done = false;

  constructor(wsUrl: string, ships: Map<string, FakeShip>) {
    const base = httpBase(wsUrl);
    FakeSocket.byBase.set(base, this);
    const ship = ships.get(base);
    setTimeout(() => {
      if (this.done) return;
      if (!ship) {
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.onopen?.({});
      if (ship.neverSync) return;
      this.emit({
        type: "sync",
        ship: ship.name,
        at: "2026-01-01T00:00:00.000Z",
        workspaces: ship.workspaces,
      });
    }, 0);
  }

  /** Push a `/events` message to the connection (drives post-init event tests). */
  emit(event: FleetEvent | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close(): void {
    this.done = true;
    this.onclose?.({});
  }
}

/** A canned SystemResources snapshot tagged by hostname so tests can tell ships apart. */
export function fakeResources(hostname: string): SystemResources {
  return {
    uptimeSeconds: 1234,
    os: {
      type: "Linux",
      platform: "linux",
      release: "6.0.0",
      version: "#1 SMP",
      arch: "x64",
      machine: "x86_64",
      hostname,
    },
    cpu: { model: "Fake CPU", cores: 8, usage: 0.25, loadAverage: [0.1, 0.2, 0.3] },
    memory: { total: 1000, free: 400, used: 600, usage: 0.6 },
  };
}

/** A fake Eden client covering the ship endpoints the manager calls. */
export function makeFakeClient(httpUrl: string, ships: Map<string, FakeShip>) {
  const ship = () => ships.get(httpUrl);

  // Every call routes through here so a ship's error/throw config applies uniformly.
  const wrap = async (dataFactory: () => unknown) => {
    const s = ship();
    if (s?.throws) throw new Error("ECONNREFUSED");
    if (s?.errorResponse) {
      return { data: null, error: { status: s.errorResponse.status, value: { error: s.errorResponse.message } } };
    }
    return { data: dataFactory(), error: null };
  };

  const workspacesFn: any = (params: { repo: string }) => (params2: { name: string }) => {
    const update = (patch: Partial<WorkspaceSummary>) => {
      const workspace = ship()?.workspaces.find((w) => w.repoName === params.repo && w.name === params2.name);
      if (workspace) Object.assign(workspace, patch);
    };
    return {
      get: () =>
        wrap(() =>
          ship()?.statusResponse ?? {
            state: "inactive",
            repoName: params.repo,
            name: params2.name,
            branch:
              ship()?.workspaces.find((w) => w.repoName === params.repo && w.name === params2.name)?.branch ?? "main",
          },
        ),
      branch: {
        post: (body: { branch: string }) =>
          wrap(() => {
            update({ branch: body.branch });
            return { ok: true };
          }),
      },
      activate: {
        post: () =>
          wrap(() => {
            update({ active: true });
            return { ok: true };
          }),
      },
      deactivate: {
        post: () =>
          wrap(() => {
            update({ active: false });
            return { ok: true };
          }),
      },
      delete: () =>
        wrap(() => {
          const s = ship();
          if (s) s.workspaces = s.workspaces.filter((w) => w.repoName !== params.repo || w.name !== params2.name);
          return { ok: true };
        }),
      diff: {
        get: () => wrap(() => `diff for ${params.repo}/${params2.name}`),
      },
    };
  };
  workspacesFn.get = () => wrap(() => ship()?.workspaceSnapshot ?? [...(ship()?.workspaces ?? [])]);
  workspacesFn.post = async (body: { url: string; repoName: string; name: string; branch: string }) => {
    const s = ship();
    if (s) s.createCalls = (s.createCalls ?? 0) + 1;
    s?.createGate?.entered();
    await s?.createGate?.wait;
    if (s?.createThenThrows) {
      s.workspaces.push({ repoName: body.repoName, name: body.name, branch: body.branch, active: false });
      throw new Error("connection closed before response");
    }
    return wrap(() => {
      const workspace = { repoName: body.repoName, name: body.name, branch: body.branch, active: false };
      ship()?.workspaces.push(workspace);
      const createResponse = ship()?.createResponse;
      return createResponse !== undefined ? createResponse : workspace;
    });
  };

  return {
    workspaces: workspacesFn,
    "system-resources": { get: () => wrap(() => fakeResources(ship()?.name ?? "unknown")) },
  };
}

/** Build `ShipConnectionDeps` backed by the fake ships (optionally overriding pieces). */
export function makeDeps(
  ships: Map<string, FakeShip>,
  overrides?: Partial<ShipConnectionDeps>,
): Partial<ShipConnectionDeps> {
  return {
    createSocket: (url) => new FakeSocket(url, ships),
    createClient: (url) => makeFakeClient(url, ships) as unknown as ReturnType<ShipConnectionDeps["createClient"]>,
    ...overrides,
  };
}

/** Convenience `WorkspaceSummary` builder. */
export const ws = (repoName: string, name: string, active = false): WorkspaceSummary => ({
  repoName,
  name,
  branch: "main",
  active,
});
