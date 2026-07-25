/**
 * attach.ts — `fleet client attach`: drive a workspace's webterm terminal from a
 * real TTY.
 *
 * Output direction: the server streams full grid snapshots, which we repaint with
 * `renderGrid`. Input direction is trivial — a TTY in raw mode already emits the
 * exact byte sequences a PTY expects (arrows, ctrl chars, …), so we forward raw
 * stdin straight through as `input` messages. Ctrl-] detaches without killing the
 * shell (the tmux session survives for re-attach).
 */

import type { WorkspaceStatus } from "fleet-protocol";
import {
  decodeServerMessage,
  splitInput,
  type ClientMsg,
} from "webterm/protocol";
import { makeClient, unwrap } from "./client";
import { renderGrid } from "./render-grid";

/** Ctrl-] — reserved as the detach key; never forwarded to the PTY. */
const DETACH_BYTE = 0x1d;

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

function terminalSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

/** Build the terminal websocket URL from a normalized ship base URL. */
function terminalWsUrl(shipUrl: string, repo: string, name: string): string {
  const base = shipUrl.replace(/^http/, "ws");
  return `${base}/workspaces/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/terminal`;
}

/** Ensure the workspace has a running session, activating it if inactive. */
async function ensureActive(shipUrl: string, repo: string, name: string): Promise<void> {
  const client = makeClient(shipUrl);
  const status = unwrap(await client.workspaces({ repo })({ name }).get()) as WorkspaceStatus;
  if (status.state === "inactive") {
    console.error(`fleet: activating ${repo}/${name}…`);
    unwrap(await client.workspaces({ repo })({ name }).activate.post());
  }
}

/**
 * Attach to `repo/name`'s terminal until the shell exits or the user detaches.
 * Resolves with the exit code to hand to `process.exit`.
 */
export async function attachToWorkspace(shipUrl: string, repo: string, name: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("fleet: attach requires an interactive terminal");
    return 1;
  }

  await ensureActive(shipUrl, repo, name);

  return await new Promise<number>((resolve) => {
    const ws = new WebSocket(terminalWsUrl(shipUrl, repo, name));

    let torn = false;
    const send = (msg: ClientMsg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const onStdin = (data: Buffer) => {
      if (data.length === 1 && data[0] === DETACH_BYTE) {
        teardown(0);
        return;
      }
      for (const chunk of splitInput(data.toString("utf8"))) {
        send({ type: "input", data: chunk });
      }
    };

    const onResize = () => {
      const { cols, rows } = terminalSize();
      send({ type: "resize", cols, rows });
    };

    const teardown = (code: number) => {
      if (torn) return;
      torn = true;
      process.stdin.off("data", onStdin);
      process.stdout.off("resize", onResize);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(LEAVE_ALT + SHOW_CURSOR);
      try {
        ws.close();
      } catch {
        // already closing
      }
      resolve(code);
    };

    const onSignal = () => teardown(130);

    ws.onopen = () => {
      process.stdout.write(ENTER_ALT);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onStdin);
      process.stdout.on("resize", onResize);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      const { cols, rows } = terminalSize();
      send({ type: "init", cols, rows });
    };

    ws.onmessage = (event) => {
      const msg = decodeServerMessage(event.data);
      if (msg.type === "grid") {
        process.stdout.write(renderGrid(msg));
      } else {
        // The server sends exit(1) when another client already holds this
        // session (only one terminal per workspace at a time).
        if (msg.code === 1 && !torn) {
          console.error(`fleet: ${repo}/${name} is already attached elsewhere`);
        }
        teardown(msg.code);
      }
    };

    ws.onerror = () => {
      if (!torn) console.error(`fleet: terminal connection to ${repo}/${name} failed`);
      teardown(1);
    };

    ws.onclose = () => teardown(0);
  });
}
