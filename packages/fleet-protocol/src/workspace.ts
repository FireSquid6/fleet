/**
 * src/workspace.ts — the workspace DTOs shared between the ship (host) and the CLI.
 *
 * A workspace is a git clone of `<repoName>` on `<branch>`, living at
 * `<fleetDirectory>/<repoName>/<name>`. It is identified by the `(repoName, name)`
 * pair — names are unique only within a repo — and is either `active` (a tmux
 * session exists) or `inactive` (only the directory exists).
 */

import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

/**
 * Summary row returned by `GET /workspaces` (list view). It is also embedded in
 * the `/events` stream, so it is a zod schema (with the type inferred from it) —
 * consumers can validate it directly.
 */
export const WorkspaceSummarySchema = z.object({
  /** Unique name of the repo the workspace belongs to (also its ship directory). */
  repoName: FleetIdentifierSchema,
  /** Workspace name, unique within its repo. */
  name: FleetIdentifierSchema,
  /** Currently checked-out branch. */
  branch: z.string(),
  /** Whether a tmux session is currently up for this workspace. */
  active: z.boolean(),
});

export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

/** Git diff summary for an active workspace. */
export const WorkspaceDiffSchema = z.object({
  /** Lines added across the working tree. */
  added: z.number(),
  /** Lines removed across the working tree. */
  removed: z.number(),
  /** Number of commits ahead of the upstream branch (0 if no upstream). */
  commits: z.number(),
});

export type WorkspaceDiff = z.infer<typeof WorkspaceDiffSchema>;

/** The lifecycle phases an agent reports as it works a task. */
export const AGENT_STATES = ["idle", "planning", "building", "verifying", "awaiting"] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const AgentStatusSchema = z.object({
  state: z.enum(AGENT_STATES),
  description: z.string(),
  model: z.string(),
  provider: z.string(),
  harness: z.string(),
});

/** Detailed status returned by `GET /workspaces/:repo/:name`. */
export const WorkspaceStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("inactive"),
    repoName: FleetIdentifierSchema,
    name: FleetIdentifierSchema,
    branch: z.string(),
  }),
  z.object({
    state: z.literal("active"),
    repoName: FleetIdentifierSchema,
    name: FleetIdentifierSchema,
    branch: z.string(),
    diff: WorkspaceDiffSchema,
    agent: AgentStatusSchema.nullable(),
    issue: z.null(),
    mergeRequest: z.null(),
    ship: FleetIdentifierSchema,
  }),
]);

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

/** Status of the coding agent attached to an active workspace's session. */
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Body of `POST /workspaces/:repo/:name/agent/status` — update the live status. */
export interface UpdateAgentStatusRequest {
  readonly state: AgentState;
  readonly description: string;
}

/** Body of `POST /workspaces` — create a workspace by cloning `url` into `repoName`. */
export const CreateWorkspaceRequestSchema = z.object({
  /** Git clone URL. */
  url: z.string(),
  /** Unique repo name; the directory the clone lands under on the ship. */
  repoName: FleetIdentifierSchema,
  name: FleetIdentifierSchema,
  branch: z.string(),
});

export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

/** Body of `POST /workspaces/:repo/:name/branch` — switch to (and create) a branch. */
export interface SwitchBranchRequest {
  readonly branch: string;
}
