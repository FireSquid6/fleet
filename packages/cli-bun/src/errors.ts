import type { RunResult } from "./backend";

/**
 * Thrown when a command that is expected to succeed exits non-zero. Subclasses
 * name the tool they wrap; `binary` prefixes the message so it reads like the
 * command line that failed.
 */
export class CliError extends Error {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(binary: string, args: readonly string[], result: RunResult) {
    // Prefer stderr for the message; fall back to stdout since some tools' errors
    // land on stdout depending on the subcommand.
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    super(`${binary} ${args.join(" ")} failed (exit ${result.exitCode}): ${detail}`);
    this.name = "CliError";
    this.args = args;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}
