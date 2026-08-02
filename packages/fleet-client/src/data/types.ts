/**
 * The bridge-local shapes (`ShipInfo`, the ship-annotated workspace DTOs) are not
 * exported from `fleet-bridge`, so they are mirrored here.
 */

import type { ArmorySyncState, WorkspaceSummary, WorkspaceStatus } from "fleet-protocol";

export type { Repo } from "fleet-protocol";
export type {
  ArmoryEntry,
  ArmoryFile,
  ArmoryInstallSummary,
  ArmoryManifest,
  ArmorySection,
  ArmorySyncState,
} from "fleet-protocol";

/** Whether the bridge currently has a live connection to a ship. */
export type ShipStatus = "online" | "offline";

/** `spec` is a human-facing hardware/region blurb (e.g. "2×A100 · us-east-1"). */
export interface Ship {
  readonly name: string;
  readonly spec: string;
  readonly status: ShipStatus;
}

export type Workspace = WorkspaceSummary & { readonly ship: string };

export type WorkspaceEvent =
  | { readonly type: "sync"; readonly at: string; readonly workspaces: Workspace[] }
  | {
      readonly type:
        | "workspace.created"
        | "workspace.branch_changed"
        | "workspace.activated"
        | "workspace.deactivated"
        | "workspace.agent_status_changed"
        | "workspace.removed";
      readonly at: string;
      readonly workspace: Workspace;
    };

/** Detail: `WorkspaceStatus` with `ship` guaranteed on both variants. */
export type WorkspaceDetail = WorkspaceStatus & { readonly ship: string };

/**
 * A row of `GET /armory/ships`. `state` is null when the bridge could not ask
 * the ship — offline, or the call failed.
 */
export interface ArmoryShipState {
  readonly ship: string;
  readonly status: ShipStatus;
  readonly state: ArmorySyncState | null;
}
