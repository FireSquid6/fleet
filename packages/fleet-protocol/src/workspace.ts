/**
 * src/workspace.ts — the workspace DTOs shared between the ship (host) and the CLI.
 *
 * A workspace is a git clone of `<repoName>` on `<branch>`, living at
 * `<fleetDirectory>/<repoName>/<name>`. It is identified by the `(repoName, name)`
 * pair — names are unique only within a repo — and is either `active` (a tmux
 * session exists) or `inactive` (only the directory exists).
 */

import { z } from "zod";

/**
 * Summary row returned by `GET /workspaces` (list view). It is also embedded in
 * the `/events` stream, so it is a zod schema (with the type inferred from it) —
 * consumers can validate it directly.
 */
export const WorkspaceSummarySchema = z.object({
  /** Unique name of the repo the workspace belongs to (also its ship directory). */
  repoName: z.string(),
  /** Workspace name, unique within its repo. */
  name: z.string(),
  /** Currently checked-out branch. */
  branch: z.string(),
  /** Whether a tmux session is currently up for this workspace. */
  active: z.boolean(),
});

export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

/** Git diff summary for an active workspace. */
export interface WorkspaceDiff {
  /** Lines added across the working tree. */
  readonly added: number;
  /** Lines removed across the working tree. */
  readonly removed: number;
  /** Number of commits ahead of the upstream branch (0 if no upstream). */
  readonly commits: number;
}

/** Detailed status returned by `GET /workspaces/:repo/:name`. */
export type WorkspaceStatus =
  | {
      readonly state: "inactive";
      readonly repoName: string;
      readonly name: string;
      readonly branch: string;
    }
  | {
      readonly state: "active";
      readonly repoName: string;
      readonly name: string;
      readonly branch: string;
      readonly diff: WorkspaceDiff;
      // The fields below are placeholders for later features; always null for now.
      readonly issue: null;
      readonly mergeRequest: null;
      readonly agentProvider: null;
      readonly agentProfile: null;
      readonly agentStatus: null;
      /** Name of the ship (host) this workspace lives on, from the ship config. */
      readonly ship: string;
    };

/** Body of `POST /workspaces` — create a workspace by cloning `url` into `repoName`. */
export interface CreateWorkspaceRequest {
  /** Git clone URL. */
  readonly url: string;
  /** Unique repo name; the directory the clone lands under on the ship. */
  readonly repoName: string;
  readonly name: string;
  readonly branch: string;
}

/** Body of `POST /workspaces/:repo/:name/branch` — switch to (and create) a branch. */
export interface SwitchBranchRequest {
  readonly branch: string;
}
