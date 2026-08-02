import { CliError } from "cli-bun";
import type { TmuxRunResult } from "./backend";

/**
 * Thrown when a tmux command that is expected to succeed exits non-zero.
 * Existence probes (`hasSession`, `exists`) do not throw this — they translate
 * the non-zero exit into `false` — so a TmuxError always signals a genuine
 * failure worth surfacing.
 */
export class TmuxError extends CliError {
  constructor(args: readonly string[], result: TmuxRunResult) {
    super("tmux", args, result);
    this.name = "TmuxError";
  }
}
