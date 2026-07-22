/**
 * fleet-protocol — the shared API + config contract between the Fleet Ship host
 * and the Fleet CLI. Pure types plus a couple of constants; no runtime deps.
 */

export {
  FleetIdentifierSchema,
  parseFleetIdentifier,
  type FleetIdentifier,
} from "./src/identifier";
export {
  DEFAULT_PORT,
  ATLAS_FILENAME,
  FleetShipConfigSchema,
  type FleetShipConfig,
  AtlasSchema,
  type Atlas,
} from "./src/config";
export {
  WorkspaceSummarySchema,
  WorkspaceStatusSchema,
  WorkspaceDiffSchema,
  AgentStatusSchema,
  CreateWorkspaceRequestSchema,
  AGENT_STATES,
  type WorkspaceSummary,
} from "./src/workspace";
export type {
  WorkspaceDiff,
  WorkspaceStatus,
  AgentStatus,
  AgentState,
  UpdateAgentStatusRequest,
  CreateWorkspaceRequest,
  SwitchBranchRequest,
} from "./src/workspace";
export type { SystemResources } from "./src/system";
export { RepoSchema, CreateRepoInputSchema, type Repo, type CreateRepoInput } from "./src/repo";
export { ShipSchema, type Ship } from "./src/ship";

export {
  SyncEventSchema,
  WorkspaceCreatedEventSchema,
  WorkspaceBranchChangedEventSchema,
  WorkspaceActivatedEventSchema,
  WorkspaceDeactivatedEventSchema,
  WorkspaceAgentStatusChangedEventSchema,
  WorkspaceRemovedEventSchema,
  FleetEventSchema,
  decodeFleetEvent,
  type SyncEvent,
  type FleetEvent,
} from "./src/events";
