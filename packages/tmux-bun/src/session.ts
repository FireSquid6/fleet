import type { TmuxCommand } from "./command";
import { SESSION_FORMAT, WINDOW_FORMAT, parseSessions, parseWindows } from "./format";
import { buildTarget } from "./target";
import { Window } from "./window";
import type { NewWindowOptions, SessionInfo, WindowInfo } from "./types";

/**
 * Handle to a session. Addressed by session id (`"$N"`) or name — both are
 * valid `-t` targets. Prefer the id (returned from {@link Tmux.newSession}) when
 * a name might be renamed out from under the handle.
 */
export class Session {
  constructor(
    private readonly cmd: TmuxCommand,
    /** The session's `-t` target — its id (`$N`) or name. */
    readonly target: string,
  ) {}

  /** Read this session's current metadata. Throws if the session no longer exists. */
  async info(): Promise<SessionInfo> {
    const out = await this.cmd.run(["display-message", "-p", "-t", this.target, SESSION_FORMAT]);
    const info = parseSessions(out)[0];
    // A dead target expands every field to "", yielding a row with an empty id.
    if (!info || info.id.length === 0) throw new Error(`session ${this.target} not found`);
    return info;
  }

  /** Whether this session exists, via `has-session`. Genuine errors still throw. */
  async exists(): Promise<boolean> {
    const res = await this.cmd.tryRun(["has-session", "-t", this.target]);
    return res.exitCode === 0;
  }

  async rename(name: string): Promise<void> {
    await this.cmd.run(["rename-session", "-t", this.target, name]);
  }

  /** Kill this session and all its windows. */
  async kill(): Promise<void> {
    await this.cmd.run(["kill-session", "-t", this.target]);
  }

  /** Create a new window in this session, returning a handle to it. */
  async newWindow(options: NewWindowOptions = {}): Promise<Window> {
    // A trailing ":" forces tmux to read the target as a session, not a window —
    // `new-window -t main` would otherwise look for a window named "main".
    const args = ["new-window", "-t", `${this.target}:`, "-P", "-F", "#{window_id}"];
    // Default to selecting the new window; `-d` creates it in the background.
    if (options.select === false) args.push("-d");
    if (options.name !== undefined) args.push("-n", options.name);
    if (options.dir !== undefined) args.push("-c", options.dir);
    if (options.command !== undefined) args.push(options.command);
    const id = (await this.cmd.run(args)).trim();
    return new Window(this.cmd, id);
  }

  async listWindows(): Promise<WindowInfo[]> {
    const out = await this.cmd.run(["list-windows", "-t", this.target, "-F", WINDOW_FORMAT]);
    return parseWindows(out);
  }

  /**
   * Get a handle to a window in this session. A window id (`"@N"`) is used
   * directly; anything else is treated as a window name or index within this
   * session.
   */
  window(ref: string | number): Window {
    const target =
      typeof ref === "string" && ref.startsWith("@")
        ? ref
        : buildTarget({ session: this.target, window: ref });
    return new Window(this.cmd, target);
  }
}
