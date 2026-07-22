import { Elysia } from "elysia";
import type { FleetManager } from "../fleet-manager";

export function eventsPlugin(manager: FleetManager) {
  const clients = new Set<{ send: (data: string) => unknown }>();
  manager.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const client of clients) client.send(payload);
  });

  return new Elysia({ name: "bridge-events" }).ws("/events", {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({
        type: "sync",
        at: new Date().toISOString(),
        workspaces: manager.workspaceSnapshot(),
      }));
    },
    message() {},
    close(ws) {
      clients.delete(ws);
    },
  });
}
