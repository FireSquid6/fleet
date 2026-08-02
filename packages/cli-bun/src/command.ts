import type { Backend, RunResult } from "./backend";
import type { CliError } from "./errors";

export type CliErrorFactory = (args: readonly string[], result: RunResult) => CliError;

/**
 * The single choke point through which every command passes. It prepends
 * {@link globalArgs} to every invocation, which is what makes whatever those
 * flags pin down — working directory, server socket — a hard guarantee: no
 * higher-level method touches them at all.
 */
export abstract class CliCommand {
  private readonly backend: Backend;
  private readonly errorFor: CliErrorFactory;

  protected constructor(backend: Backend, errorFor: CliErrorFactory) {
    this.backend = backend;
    this.errorFor = errorFor;
  }

  /** Flags prepended to every command, before the caller's own args. */
  protected abstract globalArgs(): readonly string[];

  /**
   * Run a command and return its raw result without throwing on a non-zero
   * exit. Use this for existence probes and idempotent operations where a
   * failure is an expected, meaningful outcome rather than an error.
   */
  tryRun(args: readonly string[]): Promise<RunResult> {
    return this.backend.run([...this.globalArgs(), ...args]);
  }

  /**
   * Run a command, throwing the tool's {@link CliError} subclass on a non-zero
   * exit. Returns raw stdout (not trimmed) so callers reading file content or
   * screen captures keep exact bytes; callers reading a single id/ref should
   * `.trim()` the result.
   */
  async run(args: readonly string[]): Promise<string> {
    const res = await this.tryRun(args);
    if (res.exitCode !== 0) throw this.errorFor(args, res);
    return res.stdout;
  }
}
