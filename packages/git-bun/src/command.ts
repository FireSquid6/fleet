import { ShellBackend, type GitBackend, type GitRunResult } from "./backend";
import { GitError } from "./errors";

export interface GitCommandOptions {
  /**
   * Working directory, injected as `-C <cwd>` on every invocation. Git resolves
   * `-C` before doing anything else, so the directory must already exist (the
   * static {@link Git.init}/{@link Git.clone} factories handle the not-yet-created
   * case by scoping their creating command to the parent directory instead).
   */
  cwd: string;
  /** git executable name/path. Defaults to `"git"`. */
  binary?: string;
  /**
   * Extra environment variables merged over the inherited process environment
   * for every invocation — e.g. `GIT_AUTHOR_NAME`/`GIT_COMMITTER_EMAIL` for
   * deterministic commits, or `GIT_SSH_COMMAND` for a per-repo key.
   */
  env?: Record<string, string>;
}

/**
 * The single choke point through which every git command passes. It prepends
 * `-C <cwd>` to every invocation, which is what makes the working directory a
 * hard guarantee: no higher-level method touches the `-C` flag at all.
 */
export class GitCommand {
  readonly cwd: string;
  private readonly backend: GitBackend;

  constructor(options: GitCommandOptions, backend?: GitBackend) {
    this.cwd = options.cwd;
    this.backend = backend ?? new ShellBackend(options.binary, options.env);
  }

  /**
   * `-C <cwd>` runs git as if it had been started in `cwd`, without changing the
   * parent process's own working directory.
   */
  private globalArgs(): readonly string[] {
    return ["-C", this.cwd];
  }

  /**
   * Run a command and return its raw result without throwing on a non-zero
   * exit. Use this for existence probes and idempotent operations where a
   * failure is an expected, meaningful outcome rather than an error.
   */
  tryRun(args: readonly string[]): Promise<GitRunResult> {
    return this.backend.run([...this.globalArgs(), ...args]);
  }

  /**
   * Run a command, throwing {@link GitError} on a non-zero exit. Returns raw
   * stdout (not trimmed) so callers reading diffs or file content keep exact
   * bytes; callers reading a single id/ref should `.trim()` the result.
   */
  async run(args: readonly string[]): Promise<string> {
    const res = await this.tryRun(args);
    if (res.exitCode !== 0) throw new GitError(args, res);
    return res.stdout;
  }
}
