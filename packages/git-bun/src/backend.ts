import type { Backend, RunResult } from "cli-bun";

export type GitRunResult = RunResult;

/**
 * The `args` a backend receives already include the `-C <cwd>` working-directory
 * flags, so a backend must never inject its own.
 */
export type GitBackend = Backend;

/**
 * Default backend: spawn one-shot `git` processes via Bun's shell. Bun.$
 * escapes every interpolated array element into a distinct argv entry, so there
 * is no shell to inject into and no manual quoting to get wrong.
 */
export class ShellBackend implements GitBackend {
  private readonly binary: string;
  private readonly env?: Record<string, string>;

  constructor(binary: string = "git", env?: Record<string, string>) {
    this.binary = binary;
    this.env = env;
  }

  async run(args: readonly string[]): Promise<GitRunResult> {
    const argv = [this.binary, ...args];
    // `.quiet()` keeps output out of the parent's stdio; `.nothrow()` lets us
    // inspect the exit code instead of Bun.$ throwing on non-zero. Extra env is
    // merged over the inherited process environment so callers can set e.g.
    // GIT_AUTHOR_NAME without clobbering PATH.
    let shell = Bun.$`${argv}`.quiet().nothrow();
    if (this.env) shell = shell.env({ ...process.env, ...this.env });
    const res = await shell;
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      exitCode: res.exitCode,
    };
  }
}
