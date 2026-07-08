/**
 * api/events.ts — the ship's read-only `/events` WebSocket, which fans workspace
 * state-change events out to every connected client. One Elysia chain so route
 * types stay inferable for Eden.
 */

import { Elysia } from "elysia";
import type { WorkspaceManager } from "../workspace-manager";

export function eventsPlugin(manager: WorkspaceManager) {
  const eventClients = new Set<{ send: (data: string) => unknown }>();
  manager.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const client of eventClients) client.send(payload);
  });

  return new Elysia({ name: "ship-events" }).ws("/events", {
    async open(ws) {
      // Register first so a change emitted during the snapshot is still delivered
      // (change events embed the full summary, so an overlap is idempotent).
      eventClients.add(ws);
      ws.send(JSON.stringify(await manager.snapshotEvent()));
    },
    message() {
      // Read-only stream: ignore anything the client sends.
    },
    close(ws) {
      eventClients.delete(ws);
    },
  });
}
