/**
 * View-model types for the Bridge UI.
 *
 * These reuse the real fleet contract from `fleet-protocol` wherever possible.
 * The bridge-local shapes (`ShipInfo`, the ship-annotated workspace DTOs) are not
 * exported from `fleet-bridge`, so they are mirrored here — a real client would
 * instead read them straight off `treaty<App>`'s inferred types.
 */

import type { WorkspaceSummary, WorkspaceStatus } from "fleet-protocol";

export type { Repo } from "fleet-protocol";

/** Whether the bridge currently has a live connection to a ship. */
export type ShipStatus = "online" | "offline";

/**
 * A ship (host). `spec` is the human-facing hardware/region blurb the bridge
 * would derive from the ship's `SystemResources` (e.g. "2×A100 · us-east-1").
 */
export interface Ship {
  readonly name: string;
  readonly spec: string;
  readonly status: ShipStatus;
}

/** List row: a `WorkspaceSummary` annotated with its hosting ship. */
export type Workspace = WorkspaceSummary & { readonly ship: string };

/** Detail: `WorkspaceStatus` with `ship` guaranteed on both variants. */
export type WorkspaceDetail = WorkspaceStatus & { readonly ship: string };
