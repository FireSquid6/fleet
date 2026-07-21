/**
 * api/workspaces.ts — the bridge's workspace routes: a superset of the ship's
 * workspace API, with the owning ship abstracted away (routing handled by the
 * `FleetManager`) but kept visible on every response. Built as one Elysia chain
 * so route types stay inferable for Eden.
 */

import { Elysia, t } from "elysia";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  BUFFER_LIMIT_CLOSE_CODE,
  BUFFER_LIMIT_CLOSE_REASON,
  decodeClientMessage,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  MAX_PENDING_BYTES,
  utf8ByteLength,
} from "webterm/protocol";
import type { ServerMsg } from "webterm/protocol";
import type { FleetManager } from "../fleet-manager";
import { mapError } from "./http";

export function workspacesPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-workspaces" })
    .get(
      "/workspaces",
      async ({ query, set }) => {
        try {
          const filter =
            query.active === "true" ? "active" : query.active === "false" ? "inactive" : undefined;
          return await manager.listWorkspaces(filter);
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
    .get(
      "/workspaces/:repo/:name/diff",
      async ({ params, query, set }) => {
        try {
          return await manager.getWorkspaceDiff(params.repo, params.name, {
            staged: query.staged,
            stat: query.stat,
            nameOnly: query.nameOnly,
            range: query.range,
            paths: query.paths,
            includeUntracked: query.includeUntracked,
          });
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        query: t.Object({
          staged: t.Optional(t.Boolean()),
          stat: t.Optional(t.Boolean()),
          nameOnly: t.Optional(t.Boolean()),
          range: t.Optional(t.String()),
          paths: t.Optional(t.Array(t.String())),
          includeUntracked: t.Optional(t.Boolean()),
        }),
      },
    )
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
        const data = ws.data as { upstream?: WebSocket; buffer?: string[]; pendingBytes?: number };
        data.upstream = upstream;
        data.buffer = buffer;
        data.pendingBytes = 0;
        upstream.onopen = () => {
          for (const frame of buffer) upstream.send(frame);
          buffer.length = 0;
          data.pendingBytes = 0;
        };
        upstream.onmessage = (event) => {
          if (typeof event.data === "string") {
            ws.send(event.data);
            return;
          }
          buffer.length = 0;
          data.pendingBytes = 0;
          ws.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          upstream.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
        };
        upstream.onclose = (event) => {
          buffer.length = 0;
          data.pendingBytes = 0;
          try {
            ws.close(event.code, event.reason);
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
      },
      message(ws, message) {
        const data = ws.data as { upstream?: WebSocket; buffer?: string[]; pendingBytes?: number };
        const upstream = data.upstream;
        if (!upstream) return;
        if (ArrayBuffer.isView(message) || message instanceof ArrayBuffer) {
          data.buffer?.splice(0);
          data.pendingBytes = 0;
          upstream.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          ws.close(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          return;
        }
        let frame: string;
        try {
          frame = JSON.stringify(decodeClientMessage(message));
        } catch {
          data.buffer?.splice(0);
          data.pendingBytes = 0;
          upstream.close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
          ws.close(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else {
          const pendingBytes = (data.pendingBytes ?? 0) + utf8ByteLength(frame);
          if (pendingBytes > MAX_PENDING_BYTES) {
            data.buffer?.splice(0);
            data.pendingBytes = 0;
            upstream.close(BUFFER_LIMIT_CLOSE_CODE, BUFFER_LIMIT_CLOSE_REASON);
            ws.close(BUFFER_LIMIT_CLOSE_CODE, BUFFER_LIMIT_CLOSE_REASON);
            return;
          }
          data.buffer?.push(frame);
          data.pendingBytes = pendingBytes;
        }
      },
      close(ws, code, reason) {
        const data = ws.data as { upstream?: WebSocket; buffer?: string[]; pendingBytes?: number };
        data.buffer?.splice(0);
        data.pendingBytes = 0;
        try {
          data.upstream?.close(code, reason);
        } catch {
          // already closed — releases the ship's single-terminal guard
        }
      },
    });
}
