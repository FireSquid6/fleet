import { TmuxCommand, type TmuxCommandOptions } from "./command";
import type { TmuxBackend } from "./backend";
import { SESSION_FORMAT, parseSessions } from "./format";
import { Session } from "./session";
import type { NewSessionOptions, OptionScope, SessionInfo } from "./types";

/** Construction options for {@link Tmux}. */
export type TmuxOptions = TmuxCommandOptions;

// Substrings tmux uses to report an unreachable server. Seeing one of these on a
// non-zero exit means "no server", not a real failure.
const NO_SERVER = /no server running|error connecting|No such file/i;

/**
 * Root handle for a single namespaced tmux server. Everything reachable from a
 * `Tmux` instance is confined to its namespace: the underlying
 * {@link TmuxCommand} injects `-L <namespace>` (or `-S <socketPath>`) into every
 * invocation, so no session, window, or pane outside this namespace can be
 * listed, touched, or killed.
 */
export class Tmux {
  /**
   * The low-level command helper, exposed as an escape hatch for tmux
   * subcommands this library does not wrap. Calls still go through the
   * namespace socket flags, so the isolation guarantee holds here too.
   */
  readonly command: TmuxCommand;

  constructor(options: TmuxOptions, backend?: TmuxBackend) {
    this.command = new TmuxCommand(options, backend);
  }

  get namespace(): string {
    return this.command.namespace;
  }

  /**
   * Whether this namespace's tmux server is running. A running server always
   * has at least one session (tmux exits when the last one closes), so a
   * successful `list-sessions` implies "running"; the recognizable
   * "no server" errors imply "not running". Any other failure is surfaced.
   */
  async isRunning(): Promise<boolean> {
    const res = await this.command.tryRun(["list-sessions", "-F", "#{session_id}"]);
    if (res.exitCode === 0) return true;
    if (NO_SERVER.test(res.stderr)) return false;
    // Unexpected failure — don't silently report "not running".
    throw new Error(`could not determine server state: ${res.stderr.trim()}`);
  }

  /**
   * Kill this namespace's server, tearing down all its sessions. Idempotent: a
   * "no server running" result is treated as already-done rather than an error.
   */
  async killServer(): Promise<void> {
    const res = await this.command.tryRun(["kill-server"]);
    if (res.exitCode !== 0 && !NO_SERVER.test(res.stderr)) {
      throw new Error(`kill-server failed: ${res.stderr.trim()}`);
    }
  }

  /**
   * Create a detached session (`new-session -d`) and return a handle to it,
   * keyed by its stable session id. Starts the server if it is not yet running.
   */
  async newSession(options: NewSessionOptions = {}): Promise<Session> {
    const args = ["new-session", "-d", "-P", "-F", "#{session_id}"];
    if (options.name !== undefined) args.push("-s", options.name);
    if (options.dir !== undefined) args.push("-c", options.dir);
    if (options.width !== undefined) args.push("-x", String(options.width));
    if (options.height !== undefined) args.push("-y", String(options.height));
    if (options.command !== undefined) args.push(options.command);
    const id = (await this.command.run(args)).trim();
    return new Session(this.command, id);
  }

  /** List this namespace's sessions. Returns `[]` when the server is not running. */
  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.command.tryRun(["list-sessions", "-F", SESSION_FORMAT]);
    if (res.exitCode !== 0) {
      if (NO_SERVER.test(res.stderr)) return [];
      throw new Error(`list-sessions failed: ${res.stderr.trim()}`);
    }
    return parseSessions(res.stdout);
  }

  /** Whether a session with the given name/id exists, via `has-session`. */
  async hasSession(name: string): Promise<boolean> {
    const res = await this.command.tryRun(["has-session", "-t", name]);
    return res.exitCode === 0;
  }

  /**
   * Get a handle to a session by name or id without checking existence. Use
   * {@link hasSession} or {@link Session.exists} first if the session may be
   * absent.
   */
  session(ref: string): Session {
    return new Session(this.command, ref);
  }

  /**
   * Read an option's value via `show-options -v`. Returns `undefined` when the
   * option is unset. Pass {@link OptionScope.global} for server/global options
   * or {@link OptionScope.target} to scope to a session/window.
   */
  async getOption(name: string, scope: OptionScope = {}): Promise<string | undefined> {
    const args = ["show-options", "-v"];
    if (scope.global) args.push("-g");
    if (scope.target !== undefined) args.push("-t", scope.target);
    args.push(name);
    const res = await this.command.tryRun(args);
    // An unset option exits non-zero with no output; treat that as `undefined`.
    if (res.exitCode !== 0) {
      if (res.stderr.trim().length === 0 || /unknown option|invalid option/i.test(res.stderr)) {
        return undefined;
      }
      throw new Error(`show-options failed: ${res.stderr.trim()}`);
    }
    const value = res.stdout.replace(/\n$/, "");
    return value.length === 0 ? undefined : value;
  }

  /** Set an option via `set-option`. Pass {@link OptionScope.global} for `-g`. */
  async setOption(name: string, value: string, scope: OptionScope = {}): Promise<void> {
    const args = ["set-option"];
    if (scope.global) args.push("-g");
    if (scope.target !== undefined) args.push("-t", scope.target);
    args.push(name, value);
    await this.command.run(args);
  }
}
