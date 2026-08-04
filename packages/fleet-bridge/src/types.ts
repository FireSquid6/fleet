import type {
  ArmorySyncState,
  EphemeralWorkspace,
  SystemResources,
  WorkspaceStatus,
  WorkspaceSummary,
} from "fleet-protocol";

/** Whether the bridge currently has a live `/events` connection to a ship. */
export type ShipStatus = "online" | "offline";

/** A row of `GET /ships`. */
export interface ShipInfo {
  readonly name: string;
  readonly url: string;
  readonly status: ShipStatus;
}

export type BridgeWorkspaceSummary = WorkspaceSummary & {
  ship: string;
  /** Null for an ordinary workspace; the bridge, not the ship, knows this. */
  ephemeral: EphemeralWorkspace | null;
};

export type BridgeWorkspaceStatus = WorkspaceStatus & {
  ship: string;
  ephemeral: EphemeralWorkspace | null;
};

export type BridgeWorkspaceEvent =
  | {
      readonly type: "sync";
      readonly at: string;
      readonly workspaces: BridgeWorkspaceSummary[];
    }
  | {
      readonly type:
        | "workspace.created"
        | "workspace.branch_changed"
        | "workspace.activated"
        | "workspace.deactivated"
        | "workspace.agent_status_changed"
        | "workspace.removed";
      readonly at: string;
      readonly workspace: BridgeWorkspaceSummary;
    };

/** A branch a registered repo's remote advertises — a row of `GET /repos/:name/branches`. */
export interface RepoBranch {
  readonly name: string;
  readonly sha: string;
}

/**
 * One ship's entry in the aggregate `GET /system-resources`. `resources` is
 * present when the ship is online and responded; otherwise `error` explains why
 * (offline ships report neither — `resources` and `error` are both null).
 */
export interface ShipSystemResources {
  readonly ship: string;
  readonly status: ShipStatus;
  readonly resources: SystemResources | null;
  readonly error: string | null;
}

/**
 * One ship's entry in the aggregate `GET /armory/ships`. `state` is what the
 * ship reports it has pulled and installed; it is `null` for an offline ship and
 * for one whose call failed, so a single unreachable ship never fails the whole
 * aggregate.
 */
export interface ShipArmoryState {
  readonly ship: string;
  readonly status: ShipStatus;
  readonly state: ArmorySyncState | null;
}

/** Fleet-wide identity of a workspace: `<repoName>/<name>` (unique across all ships). */
export function workspaceKey(repoName: string, name: string): string {
  return `${repoName}/${name}`;
}
