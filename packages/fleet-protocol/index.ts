/**
 * fleet-protocol — the shared API + config contract between the Fleet Ship host
 * and the Fleet CLI. Pure types plus a couple of constants; no runtime deps.
 */

export { DEFAULT_PORT, FleetShipConfigSchema, type FleetShipConfig } from "./src/config";
export type {
  WorkspaceSummary,
  WorkspaceDiff,
  WorkspaceStatus,
  CreateWorkspaceRequest,
  SwitchBranchRequest,
} from "./src/workspace";
