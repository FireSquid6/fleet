import { CliCommand } from "cli-bun";
import { ShellBackend, type TmuxBackend } from "./backend";
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
export class TmuxCommand extends CliCommand {
  readonly namespace: string;
  private readonly socketPath?: string;
  private readonly configFile?: string;

  constructor(options: TmuxCommandOptions, backend?: TmuxBackend) {
    super(
      backend ?? new ShellBackend(options.binary),
      (args, result) => new TmuxError(args, result),
    );
    this.namespace = options.namespace;
    this.socketPath = options.socketPath;
    this.configFile = options.configFile;
  }

  /**
   * Server-selecting flags prepended to every command. `-f` (config file) comes
   * first because it is a server option; then the socket selector, where `-S`
   * (explicit path) takes precedence over `-L` (named namespace) to match tmux's
   * own semantics.
   */
  protected globalArgs(): readonly string[] {
    const config = this.configFile ? ["-f", this.configFile] : [];
    const socket = this.socketPath ? ["-S", this.socketPath] : ["-L", this.namespace];
    return [...config, ...socket];
  }
}
