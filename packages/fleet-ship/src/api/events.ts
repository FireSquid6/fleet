/**
 * api/events.ts — the ship's read-only `/events` WebSocket, which fans workspace
 * state-change events out to every connected client. One Elysia chain so route
 * types stay inferable for Eden.
 */

import { Elysia } from "elysia";
import {
  BUFFER_LIMIT_CLOSE_CODE,
  BUFFER_LIMIT_CLOSE_REASON,
  MAX_PENDING_BYTES,
  utf8ByteLength,
} from "webterm/protocol";
import type { WorkspaceManager } from "../workspace-manager";

export function eventsPlugin(manager: WorkspaceManager) {
  type Client = { send: (data: string) => unknown; close: (code?: number, reason?: string) => unknown };
  type Pending = { payloads: string[]; bytes: number };
  const eventClients = new Map<Client, Pending | null>();
  manager.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const [client, pending] of eventClients) {
      if (!pending) {
        client.send(payload);
        continue;
      }
      const bytes = pending.bytes + utf8ByteLength(payload);
      if (bytes > MAX_PENDING_BYTES) {
        eventClients.delete(client);
        client.close(BUFFER_LIMIT_CLOSE_CODE, BUFFER_LIMIT_CLOSE_REASON);
        continue;
      }
      pending.payloads.push(payload);
      pending.bytes = bytes;
    }
  });

  return new Elysia({ name: "ship-events" }).ws("/events", {
    async open(ws) {
      eventClients.set(ws, { payloads: [], bytes: 0 });
      try {
        ws.send(JSON.stringify(await manager.snapshotEvent()));
        const pending = eventClients.get(ws);
        if (!pending) return;
        eventClients.set(ws, null);
        for (const payload of pending.payloads) ws.send(payload);
      } catch {
        eventClients.delete(ws);
        ws.close(1011, "Failed to build workspace snapshot");
      }
    },
    message() {
      // Read-only stream: ignore anything the client sends.
    },
    close(ws) {
      eventClients.delete(ws);
    },
  });
}
