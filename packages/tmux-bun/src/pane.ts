import type { TmuxCommand } from "./command";
import { PANE_FORMAT, parsePanes } from "./format";
import type {
  CaptureOptions,
  PaneInfo,
  ResizeOptions,
  RunOptions,
  SendKeysOptions,
  SplitOptions,
} from "./types";

/**
 * Handle to a single pane. The handle is addressed by its server-unique pane id
 * (e.g. `"%3"`), which is a valid `-t` target on its own, so operations never
 * depend on the surrounding session/window staying at a fixed index.
 */
export class Pane {
  constructor(
    private readonly cmd: TmuxCommand,
    /** The pane's `-t` target — its server-unique id (`%N`). */
    readonly target: string,
  ) {}

  /** Read this pane's current metadata. Throws if the pane no longer exists. */
  async info(): Promise<PaneInfo> {
    const out = await this.cmd.run(["display-message", "-p", "-t", this.target, PANE_FORMAT]);
    const info = parsePanes(out)[0];
    // A dead target expands every field to "", yielding a row with an empty id.
    if (!info || info.id.length === 0) throw new Error(`pane ${this.target} not found`);
    return info;
  }

  /**
   * Whether this pane still exists. `display-message` exits 0 even for a dead
   * target (expanding the id to an empty string), so existence is decided by a
   * non-empty id, which every live pane has.
   */
  async exists(): Promise<boolean> {
    const res = await this.cmd.tryRun(["display-message", "-p", "-t", this.target, "#{pane_id}"]);
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  /** Split this pane, returning a handle to the newly created pane. */
  async split(options: SplitOptions): Promise<Pane> {
    const args = ["split-window", "-t", this.target, "-P", "-F", "#{pane_id}"];
    // `-h` places the new pane to the side, `-v` below — matching tmux's own flags.
    args.push(options.direction === "horizontal" ? "-h" : "-v");
    if (options.size !== undefined) {
      args.push("-l", options.percent ? `${options.size}%` : String(options.size));
    }
    if (options.dir !== undefined) args.push("-c", options.dir);
    // Default to keeping the new pane active; `-d` opts out.
    if (options.select === false) args.push("-d");
    if (options.command !== undefined) args.push(options.command);
    const id = (await this.cmd.run(args)).trim();
    return new Pane(this.cmd, id);
  }

  /** Make this pane the active pane of its window. */
  async select(): Promise<void> {
    await this.cmd.run(["select-pane", "-t", this.target]);
  }

  /** Resize the pane directionally (by cells) and/or to an absolute size. */
  async resize(options: ResizeOptions): Promise<void> {
    const args = ["resize-pane", "-t", this.target];
    if (options.direction) {
      const flag = { left: "-L", right: "-R", up: "-U", down: "-D" }[options.direction];
      args.push(flag, String(options.amount ?? 1));
    }
    if (options.width !== undefined) args.push("-x", String(options.width));
    if (options.height !== undefined) args.push("-y", String(options.height));
    await this.cmd.run(args);
  }

  async kill(): Promise<void> {
    await this.cmd.run(["kill-pane", "-t", this.target]);
  }

  /**
   * Send literal text to the pane, optionally followed by Enter. The text is
   * sent with `-l` so tmux does not reinterpret substrings as key names (so
   * "Enter", "C-c", etc. arrive as literal characters); the trailing Enter is a
   * separate keypress issued only when {@link SendKeysOptions.enter} is set.
   */
  async sendKeys(text: string, options: SendKeysOptions = {}): Promise<void> {
    // `--` terminates option parsing so text starting with `-` is still literal.
    await this.cmd.run(["send-keys", "-t", this.target, "-l", "--", text]);
    if (options.enter) await this.cmd.run(["send-keys", "-t", this.target, "Enter"]);
  }

  /**
   * Capture the pane's contents via `capture-pane -p`. By default this returns
   * the visible region; pass {@link CaptureOptions.start}/`end` to reach into
   * scrollback.
   */
  async capture(options: CaptureOptions = {}): Promise<string> {
    const args = ["capture-pane", "-p", "-t", this.target];
    if (options.escapes) args.push("-e");
    if (options.start !== undefined) args.push("-S", String(options.start));
    if (options.end !== undefined) args.push("-E", String(options.end));
    return this.cmd.run(args);
  }

  /**
   * Type a shell command into the pane, wait for it to finish, and return only
   * that command's output. Completion is detected by bracketing the command
   * with printed marker lines and polling `capture-pane` until the end marker
   * appears on its own line. This is best-effort by nature — it assumes an
   * interactive shell is at the prompt and that output fits the captured region.
   * For deterministic, non-interactive execution use the low-level command
   * helper instead.
   */
  async run(command: string, options: RunOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const pollMs = options.pollMs ?? 50;
    // Markers are pure [A-Za-z0-9_] so they need no shell quoting and can never
    // collide with a substring of a real output line by accident.
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const startMarker = `__tmb_start_${nonce}__`;
    const endMarker = `__tmb_end_${nonce}__`;
    // The shell echoes the whole typed line (which contains both markers as part
    // of a larger command), then printf emits each marker alone on its own line.
    // Exact-line matching therefore locks onto the printed markers, not the echo.
    await this.sendKeys(
      `printf '%s\\n' ${startMarker}; ${command}; printf '%s\\n' ${endMarker}`,
      { enter: true },
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const lines = (await this.capture()).split("\n");
      const endIdx = lines.lastIndexOf(endMarker);
      if (endIdx !== -1) {
        const startIdx = lines.lastIndexOf(startMarker, endIdx);
        if (startIdx !== -1 && startIdx < endIdx) {
          return lines.slice(startIdx + 1, endIdx).join("\n");
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Pane.run timed out after ${timeoutMs}ms waiting for "${command}"`);
      }
      await Bun.sleep(pollMs);
    }
  }
}
