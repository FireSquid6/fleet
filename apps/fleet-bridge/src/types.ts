/**
 * types.ts — bridge-local response DTOs and helpers.
 *
 * The bridge exposes a superset of the ship workspace API with the owning ship
 * made visible on every workspace. These shapes are only ever consumed through
 * Elysia's own type inference (Eden), so — unlike `fleet-protocol`'s
 * `WorkspaceSummary` / event union, which a third party decodes at runtime —
 * they are plain types, not zod schemas.
 */

import type { SystemResources, WorkspaceStatus, WorkspaceSummary } from "fleet-protocol";

/** Whether the bridge currently has a live `/events` connection to a ship. */
export type ShipStatus = "online" | "offline";

/** A row of `GET /ships`. */
export interface ShipInfo {
  readonly name: string;
  readonly url: string;
  readonly status: ShipStatus;
}

/** `WorkspaceSummary` annotated with the ship that hosts it (list rows). */
export type BridgeWorkspaceSummary = WorkspaceSummary & { ship: string };

/** `WorkspaceStatus` with `ship` guaranteed present on both variants. */
export type BridgeWorkspaceStatus = WorkspaceStatus & { ship: string };

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

/** Fleet-wide identity of a workspace: `<repoName>/<name>` (unique across all ships). */
export function workspaceKey(repoName: string, name: string): string {
  return `${repoName}/${name}`;
}
