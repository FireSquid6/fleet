export interface TmuxRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The `args` a backend receives already include the namespace socket flags, so a
 * backend must never inject its own.
 */
export interface TmuxBackend {
  run(args: readonly string[]): Promise<TmuxRunResult>;
}

/**
 * Default backend: spawn one-shot `tmux` processes via Bun's shell. Bun.$
 * escapes every interpolated array element into a distinct argv entry, so there
 * is no shell to inject into and no manual quoting to get wrong.
 */
export class ShellBackend implements TmuxBackend {
  constructor(private readonly binary: string = "tmux") {}

  async run(args: readonly string[]): Promise<TmuxRunResult> {
    const argv = [this.binary, ...args];
    // `.quiet()` keeps output out of the parent's stdio; `.nothrow()` lets us
    // inspect the exit code instead of Bun.$ throwing on non-zero.
    const res = await Bun.$`${argv}`.quiet().nothrow();
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      exitCode: res.exitCode,
    };
  }
}
