import type { WorkspaceStatus } from "fleet-protocol";
import {
  decodeServerMessage,
  GridStream,
  splitInput,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  type ClientMsg,
} from "webterm/protocol";
import { unwrap } from "fleet-cli-kit";
import { makeClient } from "./client";
import { renderGrid } from "./render-grid";

/** Ctrl-] — reserved as the detach key; never forwarded to the PTY. */
const DETACH_BYTE = 0x1d;

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

function terminalSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

function terminalWsUrl(shipUrl: string, repo: string, name: string): string {
  const base = shipUrl.replace(/^http/, "ws");
  return `${base}/workspaces/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/terminal`;
}

/**
 * How to report a terminal socket the ship closed on us. The single-terminal
 * guard is the only close the user can act on, so it is the only one that gets
 * a message; a detach or a clean shell exit stays silent.
 */
export function attachCloseOutcome(
  code: number,
  workspace: string,
): { message?: string; exitCode: number } {
  if (code === TERMINAL_CONFLICT_CLOSE_CODE) {
    return {
      message: `fleet: ${workspace} is already attached elsewhere — detach that client, or take it over from the web UI`,
      exitCode: 1,
    };
  }
  if (code === TERMINAL_TAKEOVER_CLOSE_CODE) {
    return { message: `fleet: another client took over ${workspace}`, exitCode: 1 };
  }
  return { exitCode: 0 };
}

async function ensureActive(shipUrl: string, repo: string, name: string): Promise<void> {
  const client = makeClient(shipUrl);
  const status = unwrap(await client.workspaces({ repo })({ name }).get(), "fleet") as WorkspaceStatus;
  if (status.state === "inactive") {
    console.error(`fleet: activating ${repo}/${name}…`);
    unwrap(await client.workspaces({ repo })({ name }).activate.post(), "fleet");
  }
}

/** Resolves with the exit code to hand to `process.exit`. */
export async function attachToWorkspace(shipUrl: string, repo: string, name: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("fleet: attach requires an interactive terminal");
    return 1;
  }

  await ensureActive(shipUrl, repo, name);

  return await new Promise<number>((resolve) => {
    const ws = new WebSocket(terminalWsUrl(shipUrl, repo, name));

    let torn = false;
    const stream = new GridStream();
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
      if (msg.type === "exit") {
        teardown(msg.code);
        return;
      }
      const { grid, reply } = stream.accept(msg);
      if (reply) send(reply);
      if (grid) process.stdout.write(renderGrid(grid));
    };

    ws.onerror = () => {
      if (!torn) console.error(`fleet: terminal connection to ${repo}/${name} failed`);
      teardown(1);
    };

    ws.onclose = (event) => {
      if (torn) return;
      const { message, exitCode } = attachCloseOutcome(event.code, `${repo}/${name}`);
      // Tear down first — the message would be wiped with the alt screen.
      teardown(exitCode);
      if (message) console.error(message);
    };
  });
}
