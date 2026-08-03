export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// A seam, not decoration: it is what lets a future tmux control-mode backend replace one-shot process spawning.
export interface Backend {
  run(args: readonly string[]): Promise<RunResult>;
}
