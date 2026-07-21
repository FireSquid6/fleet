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
import { WORKSPACE_TMUX_NAMESPACE } from "../workspace-session";
import { mapError } from "./http";

// One terminal connection per workspace session — guards against two browser
// tabs racing to attach the same tmux session through separate PTYs.
const activeTerminals = new Map<string, true>();

export const TERMINAL_INIT_TIMEOUT_MS = 5_000;
export const TERMINAL_INIT_TIMEOUT_CLOSE_CODE = 1008;
export const TERMINAL_INIT_TIMEOUT_CLOSE_REASON = "terminal init timeout";

interface TerminalHandler {
  handle(message: ReturnType<typeof decodeClientMessage>): void;
  stop(): void;
}

interface TerminalConnectionData {
  bridge?: TerminalHandler;
  sessionName?: string;
  initialized?: boolean;
  finished?: boolean;
  initTimer?: ReturnType<typeof setTimeout>;
  finish?: (closeSocket: boolean, code?: number, reason?: string) => void;
}

type CreateTerminal = (options: ConstructorParameters<typeof TerminalBridge>[0]) => TerminalHandler;

export function workspacesPlugin(
  manager: WorkspaceManager,
  createTerminal: CreateTerminal = (options) => new TerminalBridge(options),
  initTimeoutMs = TERMINAL_INIT_TIMEOUT_MS,
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
    .get(
      "/workspaces/:repo/:name/diff",
      async ({ params, query, set }) => {
        try {
          return await manager.diff(params.repo, params.name, {
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
          clearTimeout(data.initTimer);
          data.initTimer = undefined;
          const bridge = data.bridge;
          data.bridge = undefined;
          try {
            bridge?.stop();
          } finally {
            activeTerminals.delete(sessionName);
          }
          if (closeSocket) ws.close(code, reason);
        };
        data.initTimer = setTimeout(
          () => data.finish?.(true, TERMINAL_INIT_TIMEOUT_CLOSE_CODE, TERMINAL_INIT_TIMEOUT_CLOSE_REASON),
          initTimeoutMs,
        );

        try {
          const bridge = createTerminal({
            argv: ["tmux", "-L", WORKSPACE_TMUX_NAMESPACE, "attach", "-t", sessionName],
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
          if (parsed.type === "init") {
            data.initialized = true;
            clearTimeout(data.initTimer);
            data.initTimer = undefined;
          }
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
