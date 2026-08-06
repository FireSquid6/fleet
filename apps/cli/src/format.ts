import type { ArmoryEntry, ArmorySyncState, User, WorkspaceSummary } from "fleet-protocol";
import type { Repo } from "fleet-protocol";
import type { ShipInfo, BridgeWorkspaceSummary, ShipArmoryState } from "fleet-bridge/types";
import { renderTable } from "fleet-cli-kit";

export function formatWorkspaceTable(rows: readonly WorkspaceSummary[]): string {
  return renderTable(
    ["REPO", "NAME", "BRANCH", "ACTIVE"],
    rows.map((row) => [row.repoName, row.name, row.branch, row.active ? "yes" : "no"]),
  );
}

export function formatFleetWorkspaceTable(rows: readonly BridgeWorkspaceSummary[]): string {
  return renderTable(
    ["SHIP", "REPO", "NAME", "BRANCH", "ACTIVE"],
    rows.map((row) => [row.ship, row.repoName, row.name, row.branch, row.active ? "yes" : "no"]),
  );
}

export function formatShipTable(rows: readonly ShipInfo[]): string {
  return renderTable(
    ["NAME", "URL", "STATUS"],
    rows.map((row) => [row.name, row.url, row.status]),
  );
}

export function formatRepoTable(rows: readonly Repo[]): string {
  return renderTable(
    ["NAME", "URL", "PROVIDER"],
    rows.map((row) => [row.name, row.url, row.provider]),
  );
}

export function formatUserTable(rows: readonly User[]): string {
  return renderTable(
    ["USERNAME", "EMAIL", "ROLE", "CREATED"],
    rows.map((row) => [row.username, row.email, row.role, formatTimestamp(new Date(row.createdAt))]),
  );
}

const MISSING = "-";

/** Revisions are 64 hex characters; 12 is plenty to compare two by eye. */
export function abbreviateRevision(revision: string | null): string {
  return revision ? revision.slice(0, 12) : MISSING;
}

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
 * `PATH` keeps its section prefix even though `SECTION` repeats it, so a row can
 * be pasted straight into `fleet client armory cat`.
 */
export function formatArmoryTable(rows: readonly ArmoryEntry[]): string {
  return renderTable(
    ["SECTION", "PATH", "SIZE", "MODE"],
    rows.map((row) => [row.section, row.path, String(row.size), formatMode(row.mode)]),
  );
}

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
