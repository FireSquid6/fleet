import type { SessionInfo, WindowInfo, PaneInfo } from "./types";

// Field separator woven into every `-F` format string. ASCII Unit Separator
// (0x1F) is a control character that never appears in session/window/pane names,
// titles, or paths, so splitting on it can't be fooled by user content the way a
// space, colon, or tab could.
export const FIELD_SEP = "\u001f";

function formatOf(fields: readonly string[]): string {
  return fields.map((f) => `#{${f}}`).join(FIELD_SEP);
}

/**
 * Blank lines (the trailing newline tmux emits) are dropped. With
 * `noUncheckedIndexedAccess` a missing column reads as `undefined`, so
 * downstream coercers tolerate it.
 */
function parseRows(stdout: string, fields: readonly string[]): Array<Record<string, string>> {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const cols = line.split(FIELD_SEP);
      const row: Record<string, string> = {};
      fields.forEach((field, i) => {
        row[field] = cols[i] ?? "";
      });
      return row;
    });
}

function toInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
}

// tmux flag-style variables (`#{session_attached}`, etc.) render as "1"/"0".
function toBool(value: string | undefined): boolean {
  return value === "1";
}

const SESSION_FIELDS = [
  "session_id",
  "session_name",
  "session_windows",
  "session_attached",
  "session_created",
] as const;

const WINDOW_FIELDS = [
  "window_id",
  "window_name",
  "window_index",
  "window_active",
  "window_panes",
  "window_width",
  "window_height",
] as const;

const PANE_FIELDS = [
  "pane_id",
  "pane_index",
  "pane_active",
  "pane_width",
  "pane_height",
  "pane_title",
  "pane_current_path",
  "pane_current_command",
  "pane_pid",
] as const;

/** `-F` format string that {@link parseSessions} knows how to read. */
export const SESSION_FORMAT = formatOf(SESSION_FIELDS);
/** `-F` format string that {@link parseWindows} knows how to read. */
export const WINDOW_FORMAT = formatOf(WINDOW_FIELDS);
/** `-F` format string that {@link parsePanes} knows how to read. */
export const PANE_FORMAT = formatOf(PANE_FIELDS);

export function parseSessions(stdout: string): SessionInfo[] {
  return parseRows(stdout, SESSION_FIELDS).map((r) => ({
    id: r["session_id"] ?? "",
    name: r["session_name"] ?? "",
    windows: toInt(r["session_windows"]),
    attached: toBool(r["session_attached"]),
    created: toInt(r["session_created"]),
  }));
}

export function parseWindows(stdout: string): WindowInfo[] {
  return parseRows(stdout, WINDOW_FIELDS).map((r) => ({
    id: r["window_id"] ?? "",
    name: r["window_name"] ?? "",
    index: toInt(r["window_index"]),
    active: toBool(r["window_active"]),
    panes: toInt(r["window_panes"]),
    width: toInt(r["window_width"]),
    height: toInt(r["window_height"]),
  }));
}

export function parsePanes(stdout: string): PaneInfo[] {
  return parseRows(stdout, PANE_FIELDS).map((r) => ({
    id: r["pane_id"] ?? "",
    index: toInt(r["pane_index"]),
    active: toBool(r["pane_active"]),
    width: toInt(r["pane_width"]),
    height: toInt(r["pane_height"]),
    title: r["pane_title"] ?? "",
    currentPath: r["pane_current_path"] ?? "",
    currentCommand: r["pane_current_command"] ?? "",
    pid: toInt(r["pane_pid"]),
  }));
}
