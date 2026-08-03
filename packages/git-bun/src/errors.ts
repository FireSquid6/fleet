import { CliError } from "cli-bun";
import type { GitRunResult } from "./backend";

/**
 * Thrown when a git command that is expected to succeed exits non-zero.
 * Existence probes (`isRepo`, `getConfig`) do not throw this — they translate
 * the expected non-zero exit into `false`/`undefined` — so a GitError always
 * signals a genuine failure worth surfacing.
 */
export class GitError extends CliError {
  constructor(args: readonly string[], result: GitRunResult) {
    super("git", args, result);
    this.name = "GitError";
  }
}
