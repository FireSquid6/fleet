import type { TmuxCommand } from "./command";
import { WINDOW_FORMAT, PANE_FORMAT, parseWindows, parsePanes } from "./format";
import { buildTarget } from "./target";
import { Pane } from "./pane";
import type { PaneInfo, SplitOptions, WindowInfo } from "./types";

/**
 * Handle to a window. Addressed by its server-unique window id (e.g. `"@2"`),
 * so renaming or reindexing sibling windows never invalidates the handle.
 */
export class Window {
  constructor(
    private readonly cmd: TmuxCommand,
    /** The window's `-t` target — its server-unique id (`@N`). */
    readonly target: string,
  ) {}

  /** Read this window's current metadata. Throws if the window no longer exists. */
  async info(): Promise<WindowInfo> {
    const out = await this.cmd.run(["display-message", "-p", "-t", this.target, WINDOW_FORMAT]);
    const info = parseWindows(out)[0];
    // A dead target expands every field to "", yielding a row with an empty id.
    if (!info || info.id.length === 0) throw new Error(`window ${this.target} not found`);
    return info;
  }

  /**
   * Whether this window still exists. `display-message` exits 0 even for a dead
   * target (expanding the id to an empty string), so existence is decided by a
   * non-empty id, which every live window has.
   */
  async exists(): Promise<boolean> {
    const res = await this.cmd.tryRun(["display-message", "-p", "-t", this.target, "#{window_id}"]);
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  async rename(name: string): Promise<void> {
    await this.cmd.run(["rename-window", "-t", this.target, name]);
  }

  /** Make this window the active window of its session. */
  async select(): Promise<void> {
    await this.cmd.run(["select-window", "-t", this.target]);
  }

  /** Kill this window and all its panes. */
  async kill(): Promise<void> {
    await this.cmd.run(["kill-window", "-t", this.target]);
  }

  /**
   * Split this window's active pane, returning a handle to the new pane.
   * `split-window -t @N` targets the window and splits its active pane, so the
   * window id is a valid target for the underlying command.
   */
  split(options: SplitOptions): Promise<Pane> {
    return new Pane(this.cmd, this.target).split(options);
  }

  async listPanes(): Promise<PaneInfo[]> {
    const out = await this.cmd.run(["list-panes", "-t", this.target, "-F", PANE_FORMAT]);
    return parsePanes(out);
  }

  /**
   * Get a handle to a pane in this window. A pane id (`"%N"`) is used directly;
   * anything else is treated as a pane index within this window.
   */
  pane(ref: string | number): Pane {
    const target =
      typeof ref === "string" && ref.startsWith("%")
        ? ref
        : buildTarget({ session: this.target, pane: ref });
    return new Pane(this.cmd, target);
  }
}
