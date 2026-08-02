import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

export const AGENT_STATES = ["idle", "planning", "building", "verifying", "awaiting"] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const AgentStatusSchema = z.object({
  state: z.enum(AGENT_STATES),
  description: z.string(),
  model: z.string(),
  provider: z.string(),
  harness: z.string(),
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Returned by `GET /workspaces` and embedded in the `/events` stream. */
export const WorkspaceSummarySchema = z.object({
  /** Unique name of the repo the workspace belongs to (also its ship directory). */
  repoName: FleetIdentifierSchema,
  /** Workspace name, unique within its repo. */
  name: FleetIdentifierSchema,
  branch: z.string(),
  /** Whether a tmux session is currently up for this workspace. */
  active: z.boolean(),
  /** Live agent status, or `null` when no agent is attached. */
  agent: AgentStatusSchema.nullable().default(null),
});

export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const WorkspaceDiffSchema = z.object({
  /** Lines added across the working tree. */
  added: z.number(),
  /** Lines removed across the working tree. */
  removed: z.number(),
  /** Number of commits ahead of the upstream branch (0 if no upstream). */
  commits: z.number(),
});

export type WorkspaceDiff = z.infer<typeof WorkspaceDiffSchema>;

/** Refs a workspace can be diffed against, returned by `GET /workspaces/:repo/:name/refs`. */
export const WorkspaceRefsSchema = z.object({
  /** Checked-out branch, or `""` when HEAD is detached. */
  current: z.string(),
  /** The repo's integration branch (`main`/`master`), or `null` if neither exists. */
  defaultBranch: z.string().nullable(),
  branches: z.array(
    z.object({
      /** Branch name — `origin/main` style for remote-tracking branches. */
      name: z.string(),
      remote: z.boolean(),
    }),
  ),
  /** Most recent commits on the current branch, newest first. */
  commits: z.array(
    z.object({
      sha: z.string(),
      shortSha: z.string(),
      subject: z.string(),
    }),
  ),
});

export type WorkspaceRefs = z.infer<typeof WorkspaceRefsSchema>;

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

/** Body of `POST /workspaces/:repo/:name/agent/status` — update the live status. */
export interface UpdateAgentStatusRequest {
  readonly state: AgentState;
  readonly description: string;
}

/** Body of `POST /workspaces` — create a workspace by cloning `url` into `repoName`. */
export const CreateWorkspaceRequestSchema = z.object({
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
