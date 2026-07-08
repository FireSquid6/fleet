/**
 * ship-connection.ts — one live connection to a single ship.
 *
 * A `ShipConnection` owns everything transport-related for one ship:
 *   - an Eden Treaty client (`treaty<ShipApp>`) for command/control HTTP calls,
 *   - a raw `/events` WebSocket that keeps `workspaces` (this ship's last-known
 *     `WorkspaceSummary` map) in sync, decoded via `decodeFleetEvent`,
 *   - `online`/`offline` status plus a reconnect loop with exponential backoff.
 *
 * It applies each decoded event to its own `workspaces` map and forwards it to
 * the `FleetManager` (which maintains the fleet-wide ownership index). The
 * WebSocket and Eden client are created through injectable factories so the
 * manager's dedupe/routing logic is unit-testable against fakes.
 */

import { treaty } from "@elysiajs/eden";
import type { App as ShipApp } from "fleet-ship/api";
import { decodeFleetEvent, type FleetEvent, type SyncEvent, type WorkspaceSummary } from "fleet-protocol";
import { workspaceKey, type ShipStatus } from "./types";

/** The Eden Treaty client the bridge uses to drive a ship. */
export type ShipClient = ReturnType<typeof treaty<ShipApp>>;

/** A minimal WebSocket surface — the browser/Bun `WebSocket` satisfies it. */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

/** Injectable factories (overridden in tests). */
export interface ShipConnectionDeps {
  createSocket: (url: string) => SocketLike;
  createClient: (url: string) => ShipClient;
}

/** Callbacks the manager registers to observe a connection. */
export interface ShipConnectionHandlers {
  onEvent: (conn: ShipConnection, event: FleetEvent) => void;
  onStatusChange: (conn: ShipConnection, status: ShipStatus) => void;
}

const defaultDeps: ShipConnectionDeps = {
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  createClient: (url) => treaty<ShipApp>(url),
};

const MAX_BACKOFF_MS = 30_000;

/** Turn a ship's base HTTP url into a ws(s):// url for `path`. */
export function toWsUrl(httpUrl: string, path: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = path;
  return u.toString();
}

export class ShipConnection {
  /** Discovered ship name (from its config, learned via the event stream). */
  name: string;
  readonly url: string;
  /** Whether a `/events` socket is currently open. */
  status: ShipStatus = "offline";
  /** Eden client for command/control. */
  readonly client: ShipClient;
  /** This ship's last-known workspaces, keyed by `<repo>/<name>`. */
  readonly workspaces = new Map<string, WorkspaceSummary>();
  /** True once the manager has adopted this connection into the fleet. */
  member = false;

  private readonly deps: ShipConnectionDeps;
  private handlers?: ShipConnectionHandlers;
  private socket?: SocketLike;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private syncWaiters: Array<(event: SyncEvent) => void> = [];

  constructor(opts: { url: string; name?: string; deps?: Partial<ShipConnectionDeps> }) {
    this.url = opts.url;
    this.name = opts.name ?? opts.url;
    this.deps = { ...defaultDeps, ...opts.deps };
    this.client = this.deps.createClient(opts.url);
  }

  /** Register the manager's observers. */
  setHandlers(handlers: ShipConnectionHandlers): void {
    this.handlers = handlers;
  }

  /** Open the `/events` socket and keep it reconnected until `close()`. */
  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  /** Resolve on the next `sync` event, or reject after `timeoutMs`. */
  waitForSync(timeoutMs: number): Promise<SyncEvent> {
    return new Promise((resolve, reject) => {
      const waiter = (event: SyncEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
      const timer = setTimeout(() => {
        this.syncWaiters = this.syncWaiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for sync from ${this.url}`));
      }, timeoutMs);
      this.syncWaiters.push(waiter);
    });
  }

  /** Force the connection offline (e.g. after a failed command/control call). */
  markOffline(): void {
    if (this.status !== "offline") this.setStatus("offline");
  }

  /** Stop reconnecting and tear down the socket. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
      this.socket = undefined;
    }
  }

  private openSocket(): void {
    if (this.closed) return;
    const socket = this.deps.createSocket(toWsUrl(this.url, "/events"));
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("online");
    };
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onclose = () => this.handleDisconnect();
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
    };
  }

  private handleMessage(data: unknown): void {
    let event: FleetEvent;
    try {
      event = decodeFleetEvent(typeof data === "string" ? data : String(data));
    } catch {
      return; // ignore anything that isn't a valid FleetEvent
    }

    this.name = event.ship;
    this.applyToOwnMap(event);

    if (event.type === "sync") {
      const waiters = this.syncWaiters;
      this.syncWaiters = [];
      for (const w of waiters) w(event);
    }

    this.handlers?.onEvent(this, event);
  }

  private applyToOwnMap(event: FleetEvent): void {
    switch (event.type) {
      case "sync":
        this.workspaces.clear();
        for (const w of event.workspaces) this.workspaces.set(workspaceKey(w.repo, w.name), w);
        break;
      case "workspace.removed":
        this.workspaces.delete(workspaceKey(event.workspace.repo, event.workspace.name));
        break;
      default:
        this.workspaces.set(workspaceKey(event.workspace.repo, event.workspace.name), event.workspace);
    }
  }

  private handleDisconnect(): void {
    this.socket = undefined;
    this.markOffline();
    if (this.closed) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    const jitter = base * 0.2 * Math.random();
    this.reconnectTimer = setTimeout(() => this.openSocket(), base + jitter);
  }

  private setStatus(status: ShipStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers?.onStatusChange(this, status);
  }
}
