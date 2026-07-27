/**
 * format.ts — pure formatting helpers for CLI output (no network, no I/O).
 */

import type { ArmoryEntry, ArmorySyncState, WorkspaceSummary } from "fleet-protocol";
import type { Repo } from "fleet-protocol";
import type { ShipInfo, BridgeWorkspaceSummary, ShipArmoryState } from "fleet-bridge/types";

/**
 * Render an aligned, human-readable table: a header row followed by one row per
 * entry, each column padded to its widest cell. With no rows, only the header is
 * returned.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length)),
  );

  const formatRow = (cells: readonly string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd();

  return [formatRow(headers), ...rows.map((row) => formatRow(row))].join("\n");
}

/** Render a list of workspace summaries as an aligned, human-readable table. */
export function formatWorkspaceTable(rows: readonly WorkspaceSummary[]): string {
  return renderTable(
    ["REPO", "NAME", "BRANCH", "ACTIVE"],
    rows.map((row) => [row.repoName, row.name, row.branch, row.active ? "yes" : "no"]),
  );
}

/** Render a fleet-wide workspace list, annotating each row with its owning ship. */
export function formatFleetWorkspaceTable(rows: readonly BridgeWorkspaceSummary[]): string {
  return renderTable(
    ["SHIP", "REPO", "NAME", "BRANCH", "ACTIVE"],
    rows.map((row) => [row.ship, row.repoName, row.name, row.branch, row.active ? "yes" : "no"]),
  );
}

/** Render the bridge's registered ships as a table. */
export function formatShipTable(rows: readonly ShipInfo[]): string {
  return renderTable(
    ["NAME", "URL", "STATUS"],
    rows.map((row) => [row.name, row.url, row.status]),
  );
}

/** Render the bridge's registered repos as a table. */
export function formatRepoTable(rows: readonly Repo[]): string {
  return renderTable(
    ["NAME", "URL", "PROVIDER"],
    rows.map((row) => [row.name, row.url, row.provider]),
  );
}

/** Placeholder for a column whose value does not exist yet. */
const MISSING = "-";

/** Revisions are 64 hex characters; 12 is plenty to compare two by eye. */
export function abbreviateRevision(revision: string | null): string {
  return revision ? revision.slice(0, 12) : MISSING;
}

/** Where a ship stands against the bridge's armory. */
export type ArmoryShipState = "in sync" | "behind" | "never" | "error" | "unknown";

/**
 * `error` outranks the revision comparison: a ship whose last sync failed is
 * holding a revision it could not replace, so reporting it as merely "behind"
 * would hide the reason it is stuck. `unknown` is the bridge not having been able
 * to ask at all, which is distinct from a ship answering that it holds nothing.
 *
 * `fleet-client`'s `syncStatus` derives the same thing for the web GUI. The two
 * packages do not depend on each other, so the duplication is deliberate; keep
 * their precedence identical.
 */
export function armoryShipState(bridgeRevision: string, state: ArmorySyncState | null): ArmoryShipState {
  if (!state) return "unknown";
  if (state.lastError) return "error";
  if (!state.revision) return "never";
  return state.revision === bridgeRevision ? "in sync" : "behind";
}

/**
 * Render a timestamp as ISO-8601, or the placeholder when there is none.
 *
 * Accepts a `Date` despite `ArmorySyncState.syncedAt` being typed `string`:
 * Eden Treaty revives ISO strings in a response body into `Date` objects, so the
 * declared type is not what actually arrives.
 */
export function formatTimestamp(at: string | Date | null): string {
  if (!at) return MISSING;
  const parsed = at instanceof Date ? at : new Date(at);
  return Number.isNaN(parsed.getTime()) ? String(at) : parsed.toISOString();
}

/** Modes are normalized to `0o644`/`0o755` before they reach the manifest. */
function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/**
 * Render armory manifest entries as a table. `PATH` keeps its section prefix even
 * though `SECTION` repeats it, so a row can be pasted straight into
 * `fleet client armory cat`.
 */
export function formatArmoryTable(rows: readonly ArmoryEntry[]): string {
  return renderTable(
    ["SECTION", "PATH", "SIZE", "MODE"],
    rows.map((row) => [row.section, row.path, String(row.size), formatMode(row.mode)]),
  );
}

/** Render each ship's armory state against the bridge's current `bridgeRevision`. */
export function formatArmoryShipTable(
  bridgeRevision: string,
  rows: readonly ShipArmoryState[],
): string {
  return renderTable(
    ["SHIP", "STATUS", "REVISION", "SYNCED", "STATE"],
    rows.map((row) => [
      row.ship,
      row.status,
      abbreviateRevision(row.state?.revision ?? null),
      formatTimestamp(row.state?.syncedAt ?? null),
      armoryShipState(bridgeRevision, row.state ?? null),
    ]),
  );
}
