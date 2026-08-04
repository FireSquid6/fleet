/**
 * The bridge-local shapes (`ShipInfo`, the ship-annotated workspace DTOs) are not
 * exported from `fleet-bridge`, so they are mirrored here.
 */

import type { ArmorySyncState, EphemeralWorkspace, WorkspaceSummary, WorkspaceStatus } from "fleet-protocol";

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

export type Workspace = WorkspaceSummary & {
  readonly ship: string;
  /** Null unless the bridge will delete this workspace when its issue closes. */
  readonly ephemeral: EphemeralWorkspace | null;
};

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

/** A branch a repo's remote advertises — a row of `GET /repos/:name/branches`. */
export interface RepoBranch {
  readonly name: string;
  readonly sha: string;
}

/**
 * An issue on a repo's provider — a row of `GET /repos/:name/issues`. The bridge's
 * `IssueSummary` carries more than this (`state`, `createdAt`, `updatedAt`); only
 * the fields the picker renders are mirrored, so the shape stays honest about what
 * the UI depends on.
 */
export interface RepoIssue {
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly url: string;
}

/** Detail: `WorkspaceStatus` with `ship` guaranteed on both variants. */
export type WorkspaceDetail = WorkspaceStatus & {
  readonly ship: string;
  readonly ephemeral: EphemeralWorkspace | null;
};

/**
 * A row of `GET /armory/ships`. `state` is null when the bridge could not ask
 * the ship — offline, or the call failed.
 */
export interface ArmoryShipState {
  readonly ship: string;
  readonly status: ShipStatus;
  readonly state: ArmorySyncState | null;
}
