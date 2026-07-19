/**
 * api/workspaces.ts — the bridge's workspace routes: a superset of the ship's
 * workspace API, with the owning ship abstracted away (routing handled by the
 * `FleetManager`) but kept visible on every response. Built as one Elysia chain
 * so route types stay inferable for Eden.
 */

import { Elysia, t } from "elysia";
import type { ServerMsg } from "webterm/protocol";
import type { FleetManager } from "../fleet-manager";
import { mapError } from "./http";

export function workspacesPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-workspaces" })
    .get(
      "/workspaces",
      ({ query, set }) => {
        try {
          const filter =
            query.active === "true" ? "active" : query.active === "false" ? "inactive" : undefined;
          return manager.listWorkspaces(filter);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { query: t.Object({ active: t.Optional(t.String()) }) },
    )
    .get("/workspaces/:repo/:name", async ({ params, set }) => {
      try {
        return await manager.getWorkspace(params.repo, params.name);
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .post(
      "/workspaces",
      async ({ body, set }) => {
        try {
          set.status = 201;
          return await manager.createWorkspace(body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        body: t.Object({
          ship: t.String(),
          repoName: t.String(),
          name: t.String(),
          branch: t.String(),
        }),
      },
    )
    .post(
      "/workspaces/:repo/:name/branch",
      async ({ params, body, set }) => {
        try {
          await manager.switchBranch(params.repo, params.name, body.branch);
          return { ok: true as const };
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { body: t.Object({ branch: t.String() }) },
    )
    .post("/workspaces/:repo/:name/activate", async ({ params, set }) => {
      try {
        await manager.activate(params.repo, params.name);
        return { ok: true as const };
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .post("/workspaces/:repo/:name/deactivate", async ({ params, set }) => {
      try {
        await manager.deactivate(params.repo, params.name);
        return { ok: true as const };
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .delete("/workspaces/:repo/:name", async ({ params, set }) => {
      try {
        await manager.remove(params.repo, params.name);
        return { ok: true as const };
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .ws("/workspaces/:repo/:name/terminal", {
      open(ws) {
        const { repo, name } = ws.data.params;

        let target: string;
        try {
          target = manager.terminalTarget(repo, name);
        } catch {
          // No HTTP status once a WS is open — use the ship's own exit convention.
          ws.send(JSON.stringify({ type: "exit", code: 1 } satisfies ServerMsg));
          ws.close();
          return;
        }

        // Dumb bidirectional pipe to the owning ship. Buffer client frames until
        // the upstream socket is open so the browser's first `init` isn't lost.
        const upstream = new WebSocket(target);
        const buffer: string[] = [];
        upstream.onopen = () => {
          for (const frame of buffer) upstream.send(frame);
          buffer.length = 0;
        };
        upstream.onmessage = (ev) => ws.send(typeof ev.data === "string" ? ev.data : String(ev.data));
        upstream.onclose = () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
        };
        upstream.onerror = () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
        };

        const data = ws.data as { upstream?: WebSocket; buffer?: string[] };
        data.upstream = upstream;
        data.buffer = buffer;
      },
      message(ws, message) {
        const data = ws.data as { upstream?: WebSocket; buffer?: string[] };
        const upstream = data.upstream;
        if (!upstream) return;
        const frame = typeof message === "string" ? message : JSON.stringify(message);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else data.buffer?.push(frame);
      },
      close(ws) {
        const data = ws.data as { upstream?: WebSocket };
        try {
          data.upstream?.close();
        } catch {
          // already closed — releases the ship's single-terminal guard
        }
      },
    });
}
