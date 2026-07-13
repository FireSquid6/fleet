/**
 * format.ts — pure formatting helpers for CLI output (no network, no I/O).
 */

import type { WorkspaceSummary } from "fleet-protocol";

/** Render a list of workspace summaries as an aligned, human-readable table. */
export function formatWorkspaceTable(rows: readonly WorkspaceSummary[]): string {
  const headers = ["REPO", "NAME", "BRANCH", "ACTIVE"] as const;

  const lines: string[][] = rows.map((row) => [
    row.repoName,
    row.name,
    row.branch,
    row.active ? "yes" : "no",
  ]);

  const widths = headers.map((header, col) =>
    Math.max(header.length, ...lines.map((line) => (line[col] ?? "").length)),
  );

  const formatRow = (cells: readonly string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd();

  const out = [formatRow(headers), ...lines.map((line) => formatRow(line))];
  return out.join("\n");
}
