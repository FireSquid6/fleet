/**
 * fleet-protocol — the shared API + config contract between the Fleet Ship host
 * and the Fleet CLI. Pure types plus a couple of constants; no runtime deps.
 */

export { DEFAULT_PORT, FleetShipConfigSchema, type FleetShipConfig } from "./src/config";
export { WorkspaceSummarySchema, type WorkspaceSummary } from "./src/workspace";
export type {
  WorkspaceDiff,
  WorkspaceStatus,
  CreateWorkspaceRequest,
  SwitchBranchRequest,
} from "./src/workspace";
export type { SystemResources } from "./src/system";
export type { Repo } from "./src/repo";

export {
  SyncEventSchema,
  WorkspaceCreatedEventSchema,
  WorkspaceBranchChangedEventSchema,
  WorkspaceActivatedEventSchema,
  WorkspaceDeactivatedEventSchema,
  WorkspaceRemovedEventSchema,
  FleetEventSchema,
  decodeFleetEvent,
  type SyncEvent,
  type FleetEvent,
} from "./src/events";
