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
import type { FleetManager, TerminalTarget } from "../fleet-manager";
import { openSocket } from "../ship-connection";
import { mapErrorHook } from "./http";

type TerminalProxyData = { upstream?: WebSocket; buffer?: string[]; pendingBytes?: number };

function abort(
  data: TerminalProxyData,
  ws: { close(code?: number, reason?: string): unknown },
  code: number,
  reason: string,
) {
  data.buffer?.splice(0);
  data.pendingBytes = 0;
  data.upstream?.close(code, reason);
  ws.close(code, reason);
}

export function workspacesPlugin(manager: FleetManager) {
  return new Elysia({ name: "bridge-workspaces" })
    .onError(mapErrorHook)
    .get(
      "/workspaces",
      ({ query }) => {
        const filter =
          query.active === "true" ? "active" : query.active === "false" ? "inactive" : undefined;
        return manager.listWorkspaces(filter);
      },
      { query: t.Object({ active: t.Optional(t.String()) }) },
    )
    .get("/workspaces/:repo/:name", ({ params }) => manager.getWorkspace(params.repo, params.name))
    .get(
      "/workspaces/:repo/:name/diff",
      ({ params, query }) =>
        manager.getWorkspaceDiff(params.repo, params.name, {
          staged: query.staged,
          stat: query.stat,
          nameOnly: query.nameOnly,
          range: query.range,
          mergeBase: query.mergeBase,
          paths: query.paths,
          includeUntracked: query.includeUntracked,
        }),
      {
        query: t.Object({
          staged: t.Optional(t.Boolean()),
          stat: t.Optional(t.Boolean()),
          nameOnly: t.Optional(t.Boolean()),
          range: t.Optional(t.String()),
          mergeBase: t.Optional(t.Boolean()),
          paths: t.Optional(t.Array(t.String())),
          includeUntracked: t.Optional(t.Boolean()),
        }),
      },
    )
    .get(
      "/workspaces/:repo/:name/refs",
      ({ params, query }) => manager.getWorkspaceRefs(params.repo, params.name, { commits: query.commits }),
      {
        query: t.Object({
          commits: t.Optional(t.Number()),
        }),
      },
    )
    .post(
      "/workspaces",
      async ({ body, set }) => {
        set.status = 201;
        return await manager.createWorkspace(body);
      },
      {
        body: t.Object({
          ship: t.String(),
          repoName: t.String(),
          name: t.String(),
          // Either/or, enforced by the manager rather than the schema so the
          // client gets a 400 with a reason instead of a shapeless 422.
          branch: t.Optional(t.String()),
          issueNumber: t.Optional(t.Numeric()),
        }),
      },
    )
    .post(
      "/workspaces/:repo/:name/branch",
      async ({ params, body }) => {
        await manager.switchBranch(params.repo, params.name, body.branch);
        return { ok: true as const };
      },
      { body: t.Object({ branch: t.String() }) },
    )
    .post("/workspaces/:repo/:name/activate", async ({ params }) => {
      await manager.activate(params.repo, params.name);
      return { ok: true as const };
    })
    .post("/workspaces/:repo/:name/deactivate", async ({ params }) => {
      await manager.deactivate(params.repo, params.name);
      return { ok: true as const };
    })
    .delete("/workspaces/:repo/:name", async ({ params }) => {
      await manager.remove(params.repo, params.name);
      return { ok: true as const };
    })
    .ws("/workspaces/:repo/:name/terminal", {
      query: t.Object({
        takeover: t.Optional(t.Boolean()),
      }),
      open(ws) {
        const { repo, name } = ws.data.params;

        let target: TerminalTarget;
        try {
          target = manager.terminalTarget(repo, name, { takeover: ws.data.query.takeover });
        } catch {
          // No HTTP status once a WS is open — use the ship's own exit convention.
          ws.send(JSON.stringify({ type: "exit", code: 1 } satisfies ServerMsg));
          ws.close();
          return;
        }

        // Dumb bidirectional pipe to the owning ship. Buffer client frames until
        // the upstream socket is open so the browser's first `init` isn't lost.
        const upstream = openSocket(target.url, target.headers);
        const buffer: string[] = [];
        const data = ws.data as TerminalProxyData;
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
        const data = ws.data as TerminalProxyData;
        const upstream = data.upstream;
        if (!upstream) return;
        if (ArrayBuffer.isView(message) || message instanceof ArrayBuffer) {
          abort(data, ws, BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          return;
        }
        let frame: string;
        try {
          frame = JSON.stringify(decodeClientMessage(message));
        } catch {
          abort(data, ws, INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else {
          const pendingBytes = (data.pendingBytes ?? 0) + utf8ByteLength(frame);
          if (pendingBytes > MAX_PENDING_BYTES) {
            abort(data, ws, BUFFER_LIMIT_CLOSE_CODE, BUFFER_LIMIT_CLOSE_REASON);
            return;
          }
          data.buffer?.push(frame);
          data.pendingBytes = pendingBytes;
        }
      },
      close(ws, code, reason) {
        const data = ws.data as TerminalProxyData;
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
