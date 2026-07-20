/**
 * api/workspaces.ts — the ship's workspace routes plus the per-workspace
 * terminal WebSocket. One Elysia chain so route types stay inferable for Eden.
 */

import { Elysia, t } from "elysia";
import { AGENT_STATES } from "fleet-protocol";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  decodeClientMessage,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  TerminalBridge,
} from "webterm";
import type { ServerMsg } from "webterm/protocol";
import type { WorkspaceManager } from "../workspace-manager";
import { mapError } from "./http";

// One terminal connection per workspace session — guards against two browser
// tabs racing to attach the same tmux session through separate PTYs.
const activeTerminals = new Map<string, true>();

interface TerminalHandler {
  handle(message: ReturnType<typeof decodeClientMessage>): void;
  stop(): void;
}

interface TerminalConnectionData {
  bridge?: TerminalHandler;
  sessionName?: string;
  initialized?: boolean;
  finished?: boolean;
  finish?: (closeSocket: boolean, code?: number, reason?: string) => void;
}

type CreateTerminal = (options: ConstructorParameters<typeof TerminalBridge>[0]) => TerminalHandler;

export function workspacesPlugin(
  manager: WorkspaceManager,
  createTerminal: CreateTerminal = (options) => new TerminalBridge(options),
) {
  return new Elysia({ name: "ship-workspaces" })
    .get(
      "/workspaces",
      async ({ query, set }) => {
        try {
          const active =
            query.active === undefined
              ? undefined
              : query.active === "true"
                ? "active"
                : query.active === "false"
                  ? "inactive"
                  : undefined;
          return await manager.list(active);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        query: t.Object({
          active: t.Optional(t.String()),
        }),
      },
    )
    .get("/workspaces/:repo/:name", async ({ params, set }) => {
      try {
        return await manager.get(params.repo, params.name);
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
          return await manager.create(body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        body: t.Object({
          url: t.String(),
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
          await manager.switchBranch(params.repo, params.name, body);
          return { ok: true as const };
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        body: t.Object({
          branch: t.String(),
        }),
      },
    )
    .post(
      "/workspaces/:repo/:name/agent/init",
      async ({ params, body, set }) => {
        try {
          return await manager.initAgent(params.repo, params.name, body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        body: t.Object({
          model: t.String(),
          provider: t.String(),
          harness: t.String(),
        }),
      },
    )
    .get("/workspaces/:repo/:name/agent/status", async ({ params, set }) => {
      try {
        return manager.agentStatus(params.repo, params.name);
      } catch (err) {
        const mapped = mapError(err);
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .post(
      "/workspaces/:repo/:name/agent/status",
      async ({ params, body, set }) => {
        try {
          return await manager.updateAgentStatus(params.repo, params.name, body);
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      {
        body: t.Object({
          state: t.UnionEnum(AGENT_STATES),
          description: t.String(),
        }),
      },
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
        const sessionName = manager.sessionName(repo, name);

        if (activeTerminals.has(sessionName)) {
          ws.send(JSON.stringify({ type: "exit", code: 1 } satisfies ServerMsg));
          ws.close();
          return;
        }
        activeTerminals.set(sessionName, true);

        const data = ws.data as TerminalConnectionData;
        data.sessionName = sessionName;
        data.initialized = false;
        data.finished = false;
        data.finish = (closeSocket, code, reason) => {
          if (data.finished) return;
          data.finished = true;
          const bridge = data.bridge;
          data.bridge = undefined;
          try {
            bridge?.stop();
          } finally {
            activeTerminals.delete(sessionName);
          }
          if (closeSocket) ws.close(code, reason);
        };

        try {
          const bridge = createTerminal({
            argv: ["tmux", "-L", "fleet-ship", "attach", "-t", sessionName],
            send: (msg: ServerMsg) => {
              if (msg.type === "exit") {
                try {
                  ws.send(JSON.stringify(msg));
                } finally {
                  data.finish?.(true);
                }
              } else {
                ws.send(JSON.stringify(msg));
              }
            },
          });
          if (data.finished) bridge.stop();
          else data.bridge = bridge;
        } catch {
          data.finish(true);
        }
      },
      message(ws, message) {
        const data = ws.data as TerminalConnectionData;
        if (!data.bridge) return;
        const reject = (code: number, reason: string) => {
          data.finish?.(true, code, reason);
        };
        if (ArrayBuffer.isView(message) || message instanceof ArrayBuffer) {
          reject(BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON);
          return;
        }
        try {
          const parsed = decodeClientMessage(message);
          if ((parsed.type === "init") !== !data.initialized) {
            reject(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
            return;
          }
          if (parsed.type === "init") data.initialized = true;
          data.bridge.handle(parsed);
        } catch {
          reject(INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON);
        }
      },
      close(ws) {
        (ws.data as TerminalConnectionData).finish?.(false);
      },
    });
}
