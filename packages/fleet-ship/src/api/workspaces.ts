import { Elysia, t } from "elysia";
import { AGENT_STATES } from "fleet-protocol";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  decodeClientMessage,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  MAX_PENDING_BYTES,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_CONFLICT_CLOSE_REASON,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_REASON,
  TerminalBridge,
} from "webterm";
import type { ServerMsg } from "webterm/protocol";
import type { WorkspaceManager } from "../workspace-manager";
import { WORKSPACE_TMUX_NAMESPACE } from "../workspace-session";
import { mapErrorHook } from "./http";

// One terminal connection per workspace session — guards against two browser
// tabs racing to attach the same tmux session through separate PTYs. The value
// is the incumbent's connection state so a later connection asking for a
// takeover can evict it through its own `finish`.
const activeTerminals = new Map<string, TerminalConnectionData>();

/**
 * Unflushed bytes on the terminal socket past which the bridge stops producing
 * frames. Matches `MAX_PENDING_BYTES`, the bound every other hop in the chain
 * uses for the same judgement ("the peer is not draining"), and is several full
 * snapshots wide at any sane terminal size, so an ordinary in-flight frame
 * never trips it — this is a backstop under the ack window, not a substitute.
 */
const TERMINAL_BACKPRESSURE_BYTES = MAX_PENDING_BYTES;

/**
 * Elysia's `ws` is a wrapper; `ws.raw` is Bun's `ServerWebSocket`, which does
 * expose `getBufferedAmount()` even though the `ServerWebSocket` declaration
 * Elysia bundles predates it. Read defensively rather than widening the type:
 * a wrapper without it just means no congestion signal, not a crash.
 */
function bufferedAmount(ws: unknown): number {
  const raw = (ws as { raw?: { getBufferedAmount?: () => number } }).raw;
  return raw?.getBufferedAmount?.() ?? 0;
}

const TERMINAL_INIT_TIMEOUT_MS = 5_000;
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
    .onError(mapErrorHook)
    .get(
      "/workspaces",
      ({ query }) => {
        const active =
          query.active === undefined
            ? undefined
            : query.active === "true"
              ? "active"
              : query.active === "false"
                ? "inactive"
                : undefined;
        return manager.list(active);
      },
      {
        query: t.Object({
          active: t.Optional(t.String()),
        }),
      },
    )
    .get("/workspaces/:repo/:name", ({ params }) => manager.get(params.repo, params.name))
    .get(
      "/workspaces/:repo/:name/diff",
      ({ params, query }) =>
        manager.diff(params.repo, params.name, {
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
      ({ params, query }) => manager.refs(params.repo, params.name, { commits: query.commits }),
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
        return await manager.create(body);
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
      async ({ params, body }) => {
        await manager.switchBranch(params.repo, params.name, body);
        return { ok: true as const };
      },
      {
        body: t.Object({
          branch: t.String(),
        }),
      },
    )
    .post(
      "/workspaces/:repo/:name/agent/init",
      ({ params, body }) => manager.initAgent(params.repo, params.name, body),
      {
        body: t.Object({
          model: t.String(),
          provider: t.String(),
          harness: t.String(),
        }),
      },
    )
    .get("/workspaces/:repo/:name/agent/status", ({ params }) =>
      manager.agentStatus(params.repo, params.name),
    )
    .post(
      "/workspaces/:repo/:name/agent/status",
      ({ params, body }) => manager.updateAgentStatus(params.repo, params.name, body),
      {
        body: t.Object({
          state: t.UnionEnum(AGENT_STATES),
          description: t.String(),
        }),
      },
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
        const sessionName = manager.sessionName(repo, name);

        const incumbent = activeTerminals.get(sessionName);
        if (incumbent) {
          if (!ws.data.query.takeover) {
            // Leave the incumbent's entry and bridge untouched — the close code
            // is the whole signal, and the browser offers a takeover from it.
            ws.close(TERMINAL_CONFLICT_CLOSE_CODE, TERMINAL_CONFLICT_CLOSE_REASON);
            return;
          }
          // Evict before registering: `finish` clears the incumbent's map entry,
          // so claiming the session first would drop our own registration.
          incumbent.finish?.(true, TERMINAL_TAKEOVER_CLOSE_CODE, TERMINAL_TAKEOVER_CLOSE_REASON);
        }

        const data = ws.data as TerminalConnectionData;
        activeTerminals.set(sessionName, data);
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
            // Invariant: a connection only ever releases the guard it holds.
            // Every replacement path finishes the incumbent *before* claiming
            // the session, so today the entry is always ours; the check keeps
            // that assumption checkable here rather than at each call site.
            if (activeTerminals.get(sessionName) === data) activeTerminals.delete(sessionName);
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
            // The client's acks pace the stream against the far end; this paces
            // it against the near one, which the acks cannot see.
            congested: () => bufferedAmount(ws) > TERMINAL_BACKPRESSURE_BYTES,
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
