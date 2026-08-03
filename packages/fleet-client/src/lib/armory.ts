import { ARMORY_SECTIONS } from "fleet-protocol";
import type { ArmorySection, ArmorySyncState } from "@/data/types";

export const SECTION_ORDER: readonly ArmorySection[] = ARMORY_SECTIONS;

/**
 * Where a ship stands against the bridge's armory. `unknown` is the bridge not
 * having been able to ask (offline ship); it is deliberately distinct from
 * `never synced`, which is the ship answering that it holds nothing.
 */
export type ArmorySyncStatus = "in sync" | "behind" | "never synced" | "error" | "unknown";

/**
 * `error` outranks the revision comparison: a ship whose last sync failed is
 * holding a revision it could not replace, so reporting it as merely "behind"
 * would hide the reason it is stuck.
 */
export function syncStatus(bridgeRevision: string, state: ArmorySyncState | null): ArmorySyncStatus {
  if (!state) return "unknown";
  if (state.lastError) return "error";
  if (!state.revision) return "never synced";
  return state.revision === bridgeRevision ? "in sync" : "behind";
}

/** Revisions are 64 hex characters; 12 is plenty to compare two by eye. */
export function abbreviateRevision(revision: string | null): string {
  if (!revision) return "—";
  return revision.slice(0, 12);
}

export function stripSection(path: string, section: string): string {
  return path.startsWith(`${section}/`) ? path.slice(section.length + 1) : path;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** An ISO timestamp as a local, human-readable string; `—` when there is none. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}
