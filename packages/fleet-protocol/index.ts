export { FleetIdentifierSchema, parseFleetIdentifier } from "./src/identifier";
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
  WorkspaceRefsSchema,
  AgentStatusSchema,
  CreateWorkspaceRequestSchema,
  AGENT_STATES,
  type WorkspaceSummary,
} from "./src/workspace";
export type {
  WorkspaceDiff,
  WorkspaceRefs,
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
  ARMORY_SECTIONS,
  ARMORY_DIRECTORY,
  DOTFILE_MAP_FILENAME,
  isSafeArmoryPath,
  ArmoryEntrySchema,
  DotfileMapSchema,
  ArmoryManifestSchema,
  ArmoryFileSchema,
  ArmorySyncRequestSchema,
  ArmorySyncStateSchema,
  ArmoryInstallSummarySchema,
  type ArmorySection,
  type ArmoryEntry,
  type DotfileMap,
  type ArmoryManifest,
  type ArmoryFile,
  type ArmorySyncRequest,
  type ArmorySyncState,
  type ArmoryInstallSummary,
} from "./src/armory";

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
