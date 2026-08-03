/** A tmux session as reported by `list-sessions` / `display-message`. */
export interface SessionInfo {
  /** Server-unique id, e.g. `"$0"`. Usable directly as a `-t` target. */
  id: string;
  name: string;
  windows: number;
  /** Whether a client is currently attached. Headless sessions are `false`. */
  attached: boolean;
  /** Creation time as a Unix epoch (seconds). */
  created: number;
}

/** A tmux window as reported by `list-windows` / `display-message`. */
export interface WindowInfo {
  /** Server-unique id, e.g. `"@0"`. Usable directly as a `-t` target. */
  id: string;
  name: string;
  /** Position of the window within its session. */
  index: number;
  /** Whether this is the session's active window. */
  active: boolean;
  panes: number;
  width: number;
  height: number;
}

/** A tmux pane as reported by `list-panes` / `display-message`. */
export interface PaneInfo {
  /** Server-unique id, e.g. `"%0"`. Usable directly as a `-t` target. */
  id: string;
  /** Position of the pane within its window. */
  index: number;
  /** Whether this is the window's active pane. */
  active: boolean;
  width: number;
  height: number;
  title: string;
  /** Working directory of the pane's foreground process. */
  currentPath: string;
  /** Name of the pane's foreground command, e.g. `"bash"`. */
  currentCommand: string;
  /** PID of the pane's foreground process. */
  pid: number;
}

export interface NewSessionOptions {
  /** Session name (`-s`). tmux assigns a numeric name if omitted. */
  name?: string;
  /** Starting working directory (`-c`). */
  dir?: string;
  /** Command to run instead of the default shell (trailing argument). */
  command?: string;
  /** Initial window width in columns (`-x`). Defaults to tmux's headless size. */
  width?: number;
  /** Initial window height in rows (`-y`). */
  height?: number;
}

export interface NewWindowOptions {
  /** Window name (`-n`). */
  name?: string;
  /** Starting working directory (`-c`). */
  dir?: string;
  /** Command to run instead of the default shell (trailing argument). */
  command?: string;
  /** Make the new window the active one. Defaults to `true`; `false` adds `-d`. */
  select?: boolean;
}

/** Direction of a pane split: `"horizontal"` = side by side, `"vertical"` = stacked. */
export type SplitDirection = "horizontal" | "vertical";

export interface SplitOptions {
  direction: SplitDirection;
  /** New pane size (`-l`). Interpreted as a percentage when {@link percent} is set. */
  size?: number;
  /** Treat {@link size} as a percentage of the available space. */
  percent?: boolean;
  /** Starting working directory for the new pane (`-c`). */
  dir?: string;
  /** Command to run in the new pane instead of the default shell. */
  command?: string;
  /** Make the new pane active. Defaults to `true`; `false` adds `-d`. */
  select?: boolean;
}

export type ResizeDirection = "left" | "right" | "up" | "down";

/** Directional and absolute forms may be combined. */
export interface ResizeOptions {
  /** Resize toward this edge by {@link amount} cells. */
  direction?: ResizeDirection;
  /** Number of cells to move by when {@link direction} is set. Defaults to 1. */
  amount?: number;
  /** Absolute width in columns (`-x`). */
  width?: number;
  /** Absolute height in rows (`-y`). */
  height?: number;
}

export interface SendKeysOptions {
  /** Send a trailing `Enter` after the literal text, submitting the line. */
  enter?: boolean;
}

export interface CaptureOptions {
  /** First line to capture (`-S`). Negative values reach into scrollback. */
  start?: number;
  /** Last line to capture (`-E`). */
  end?: number;
  /** Include escape sequences for colours/attributes (`-e`). */
  escapes?: boolean;
}

export interface RunOptions {
  /** Give up after this many milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /** Delay between capture polls while waiting for completion. Defaults to 50. */
  pollMs?: number;
}

export interface OptionScope {
  /** Operate on a server/global option (`-g`). */
  global?: boolean;
  /** Restrict to a specific target (`-t`), e.g. a session for a session option. */
  target?: string;
}
