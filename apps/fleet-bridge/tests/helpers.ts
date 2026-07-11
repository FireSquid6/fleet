/**
 * helpers.ts — shared fakes for the bridge test suite.
 *
 * A `FleetManager` is built against a fake `SocketLike` (`/events`) and a fake
 * Eden client, so the dedupe/routing/error logic is exercised with no real ships.
 * `FakeSocket.byBase` lets a test grab a ship's live socket to close it (force
 * offline) or `emit()` a post-init event; a ship can also be configured to never
 * sync, to return an Eden error, or to throw (network failure).
 */

import { basename } from "node:path";
import type { FleetEvent, SystemResources, WorkspaceSummary } from "fleet-protocol";
import type { ShipConnectionDeps, SocketLike } from "../src/ship-connection";

/** A ship the fakes pretend exists at a given base URL. */
export interface FakeShip {
  name: string;
  workspaces: WorkspaceSummary[];
  /** Socket opens but never sends a `sync` (for waitForSync timeout tests). */
  neverSync?: boolean;
  /** All Eden calls resolve to this error `{status, value:{error}}`. */
  errorResponse?: { status: number; message: string };
  /** All Eden calls throw (simulated network failure). */
  throws?: boolean;
}

export function repoBasename(repoUrlOrName: string): string {
  const base = basename(repoUrlOrName);
  return base.endsWith(".git") ? base.slice(0, -".git".length) : base;
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

  const workspacesFn: any = (params: { repo: string }) => (params2: { name: string }) => ({
    get: () => wrap(() => ({ state: "inactive", repo: params.repo, name: params2.name, branch: "main" })),
    branch: { post: () => wrap(() => ({ ok: true })) },
    activate: { post: () => wrap(() => ({ ok: true })) },
    deactivate: { post: () => wrap(() => ({ ok: true })) },
    delete: () => wrap(() => ({ ok: true })),
  });
  workspacesFn.get = () => wrap(() => [...(ship()?.workspaces ?? [])]);
  workspacesFn.post = (body: { repo: string; name: string; branch: string }) =>
    wrap(() => ({ repo: repoBasename(body.repo), name: body.name, branch: body.branch, active: false }));

  return {
    workspaces: workspacesFn,
    "system-resources": { get: () => wrap(() => fakeResources(ship()?.name ?? "unknown")) },
    repos: { get: () => wrap(() => reposOf(ship())) },
  };
}

/** Derive a RepoSummary[] from a fake ship's workspaces (grouped by repo). */
export function reposOf(ship?: FakeShip) {
  if (!ship) return [];
  const counts = new Map<string, number>();
  for (const w of ship.workspaces) counts.set(w.repo, (counts.get(w.repo) ?? 0) + 1);
  return [...counts.entries()].map(([repo, workspaces]) => ({
    repo,
    remote: `git@fake/${repo}.git`,
    workspaces,
  }));
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
export const ws = (repo: string, name: string, active = false): WorkspaceSummary => ({
  repo,
  name,
  branch: "main",
  active,
});
