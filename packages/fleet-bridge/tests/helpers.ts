import type { ArmorySyncState, FleetEvent, Role, SystemResources, User, WorkspaceSummary } from "fleet-protocol";
import { createApp } from "../src/api";
import { AuthDatabase } from "../src/auth/auth-database";
import { AuthService } from "../src/auth/auth-service";
import type { FleetManager } from "../src/fleet-manager";
import type { ShipConnectionDeps, SocketLike } from "../src/ship-connection";

export const TEST_PASSWORD = "test-password";

export function makeTestAuth(): AuthService {
  const db = new AuthDatabase(":memory:");
  db.migrate();
  return new AuthService(db);
}

export async function makeAuthedApp(
  manager: FleetManager,
  options: { insecureNoAuth?: boolean } = {},
): Promise<{ app: ReturnType<typeof createApp>; auth: AuthService; authorization: string }> {
  const auth = makeTestAuth();
  const { authorization } = await seedUser(auth, { username: "test-admin", role: "admin" });
  return { app: createApp(manager, auth, options), auth, authorization };
}

export async function seedUser(
  auth: AuthService,
  input: { username: string; email?: string; password?: string; role?: Role },
): Promise<{ user: User; token: string; authorization: string }> {
  const password = input.password ?? TEST_PASSWORD;
  const user = await auth.createUser({
    username: input.username,
    email: input.email ?? `${input.username}@fleet.test`,
    password,
    role: input.role ?? "member",
  });
  const { token } = await auth.login(input.username, password);
  return { user, token, authorization: `Bearer ${token}` };
}

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
  /** Every `POST /armory/sync` this ship received, in order. */
  armorySyncs?: { bridgeUrl: string; revision: string }[];
  /** Every `POST /agent/credentials` this ship received, in order. */
  agentCredentials?: { bridgeUrl: string; token: string }[];
  /** What `GET /armory` reports; defaults to a ship that has never synced. */
  armoryState?: ArmorySyncState;
  authorizations?: (string | null)[];
  socketAuthorizations?: (string | null)[];
  /** All Eden calls resolve to this error `{status, value:{error}}`. */
  errorResponse?: { status: number; message: string };
  /** All Eden calls throw (simulated network failure). */
  throws?: boolean;
}

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

  constructor(wsUrl: string, ships: Map<string, FakeShip>, bridgeToken?: string) {
    const base = httpBase(wsUrl);
    FakeSocket.byBase.set(base, this);
    const ship = ships.get(base);
    if (ship) (ship.socketAuthorizations ??= []).push(authorizationHeader(bridgeToken));
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

export function authorizationHeader(token?: string): string | null {
  return token === undefined ? null : `Bearer ${token}`;
}

export function makeFakeClient(httpUrl: string, ships: Map<string, FakeShip>, bridgeToken?: string) {
  const ship = () => ships.get(httpUrl);

  // Every call routes through here so a ship's error/throw config applies uniformly.
  const wrap = async (dataFactory: () => unknown) => {
    const s = ship();
    if (s) (s.authorizations ??= []).push(authorizationHeader(bridgeToken));
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
      refs: {
        get: () =>
          wrap(() => ({
            current: "main",
            defaultBranch: "main",
            branches: [{ name: "main", remote: false }],
            commits: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: `commit for ${params2.name}` }],
          })),
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
      s.workspaces.push({ repoName: body.repoName, name: body.name, branch: body.branch, active: false, agent: null });
      throw new Error("connection closed before response");
    }
    return wrap(() => {
      const workspace = { repoName: body.repoName, name: body.name, branch: body.branch, active: false, agent: null };
      ship()?.workspaces.push(workspace);
      const createResponse = ship()?.createResponse;
      return createResponse !== undefined ? createResponse : workspace;
    });
  };

  return {
    workspaces: workspacesFn,
    "system-resources": { get: () => wrap(() => fakeResources(ship()?.name ?? "unknown")) },
    agent: {
      credentials: {
        post: (body: { bridgeUrl: string; token: string }) => {
          const s = ship();
          if (s) (s.agentCredentials ??= []).push(body);
          return wrap(() => ({ ok: true }));
        },
      },
    },
    armory: {
      get: () =>
        wrap(
          () =>
            ship()?.armoryState ?? {
              revision: null,
              bridgeUrl: null,
              syncedAt: null,
              fileCount: 0,
              install: null,
              lastError: null,
            },
        ),
      sync: {
        post: (body: { bridgeUrl: string; revision: string }) => {
          const s = ship();
          // Recorded before `wrap`, so a ship configured to error or throw still
          // shows what the bridge tried to push.
          if (s) (s.armorySyncs ??= []).push(body);
          return wrap(() => ({
            revision: body.revision,
            bridgeUrl: body.bridgeUrl,
            syncedAt: "2026-01-01T00:00:00.000Z",
            fileCount: 0,
            lastError: null,
          }));
        },
      },
    },
  };
}

export function makeDeps(
  ships: Map<string, FakeShip>,
  overrides?: Partial<ShipConnectionDeps>,
): Partial<ShipConnectionDeps> {
  return {
    createSocket: (url, bridgeToken) => new FakeSocket(url, ships, bridgeToken),
    createClient: (url, bridgeToken) =>
      makeFakeClient(url, ships, bridgeToken) as unknown as ReturnType<ShipConnectionDeps["createClient"]>,
    ...overrides,
  };
}

export const ws = (repoName: string, name: string, active = false): WorkspaceSummary => ({
  repoName,
  name,
  branch: "main",
  active,
  agent: null,
});
