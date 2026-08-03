import { CliCommand } from "cli-bun";
import { ShellBackend, type GitBackend } from "./backend";
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
export class GitCommand extends CliCommand {
  readonly cwd: string;

  constructor(options: GitCommandOptions, backend?: GitBackend) {
    super(
      backend ?? new ShellBackend(options.binary, options.env),
      (args, result) => new GitError(args, result),
    );
    this.cwd = options.cwd;
  }

  /**
   * `-C <cwd>` runs git as if it had been started in `cwd`, without changing the
   * parent process's own working directory.
   */
  protected globalArgs(): readonly string[] {
    return ["-C", this.cwd];
  }
}
