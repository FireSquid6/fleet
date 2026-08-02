import { ShellBackend, type TmuxBackend, type TmuxRunResult } from "./backend";
import { TmuxError } from "./errors";

export interface TmuxCommandOptions {
  /** Server namespace, injected as `-L <namespace>`. Runs a private tmux server. */
  namespace: string;
  /**
   * Explicit socket path, injected as `-S <socketPath>`. Overrides `-L` when
   * set — useful for tests that want a throwaway socket in a temp dir.
   */
  socketPath?: string;
  /** tmux executable name/path. Defaults to `"tmux"`. */
  binary?: string;
  /**
   * Config file to load when this namespace's server starts (`-f`). Defaults to
   * tmux's own default (the user's `~/.tmux.conf`). Pass `"/dev/null"` for fully
   * deterministic behavior — e.g. `base-index`/`pane-base-index` at their
   * built-in defaults — independent of the user's personal configuration.
   */
  configFile?: string;
}

/**
 * The single choke point through which every tmux command passes. It prepends
 * the namespace socket flags to every invocation, which is what makes namespace
 * isolation a hard guarantee: no higher-level method touches the socket flags.
 */
export class TmuxCommand {
  readonly namespace: string;
  private readonly socketPath?: string;
  private readonly configFile?: string;
  private readonly backend: TmuxBackend;

  constructor(options: TmuxCommandOptions, backend?: TmuxBackend) {
    this.namespace = options.namespace;
    this.socketPath = options.socketPath;
    this.configFile = options.configFile;
    this.backend = backend ?? new ShellBackend(options.binary);
  }

  /**
   * Server-selecting flags prepended to every command. `-f` (config file) comes
   * first because it is a server option; then the socket selector, where `-S`
   * (explicit path) takes precedence over `-L` (named namespace) to match tmux's
   * own semantics.
   */
  private globalArgs(): readonly string[] {
    const config = this.configFile ? ["-f", this.configFile] : [];
    const socket = this.socketPath ? ["-S", this.socketPath] : ["-L", this.namespace];
    return [...config, ...socket];
  }

  /**
   * Run a command and return its raw result without throwing on a non-zero
   * exit. Use this for existence probes and idempotent teardown where a
   * failure is an expected, meaningful outcome rather than an error.
   */
  tryRun(args: readonly string[]): Promise<TmuxRunResult> {
    return this.backend.run([...this.globalArgs(), ...args]);
  }

  /**
   * Run a command, throwing {@link TmuxError} on a non-zero exit. Returns raw
   * stdout (not trimmed) so callers such as `capturePane` keep exact content;
   * callers reading a single id should `.trim()` the result.
   */
  async run(args: readonly string[]): Promise<string> {
    const res = await this.tryRun(args);
    if (res.exitCode !== 0) throw new TmuxError(args, res);
    return res.stdout;
  }
}
