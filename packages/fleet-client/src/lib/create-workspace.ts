/**
 * lib/create-workspace.ts — the decisions behind the create-workspace form:
 * what to tell the user about the branch they typed, and what request that form
 * state amounts to. Both live here rather than in the component so they can be
 * tested without a DOM — there is no DOM harness in this package — leaving the
 * component with rendering.
 */

import { issueBranchName } from "fleet-protocol";
import type { RepoBranch, RepoIssue } from "@/data/types";

/**
 * What the form knows about the branch the user typed.
 *
 * `unknown` is the branch list being unavailable — still loading, or the remote
 * refused to list it. It is deliberately distinct from `new`: without the list
 * there is no way to tell an existing branch from one about to be created, and
 * guessing wrong in either direction is worse than saying nothing.
 */
export type BranchState =
  | { readonly kind: "empty" }
  | { readonly kind: "unknown" }
  | { readonly kind: "existing"; readonly branch: string }
  | { readonly kind: "new"; readonly branch: string };

/**
 * Classify the typed branch against the repo's branches, `null` when that list
 * could not be loaded. The comparison is case-sensitive on the trimmed input,
 * because git refs are: `Main` and `main` are two different branches.
 */
export function branchState(input: string, branches: RepoBranch[] | null): BranchState {
  const branch = input.trim();
  if (branch.length === 0) return { kind: "empty" };
  if (branches === null) return { kind: "unknown" };
  return branches.some((b) => b.name === branch) ? { kind: "existing", branch } : { kind: "new", branch };
}

/**
 * The text an issue is matched and displayed as. The number is part of it so
 * that typing `12` and typing `workspace` both find issue #12.
 */
export function issueText(issue: Pick<RepoIssue, "number" | "title">): string {
  return `#${issue.number} ${issue.title}`;
}

/**
 * The branch the bridge will derive for an issue, or null if it cannot be
 * derived. `issueBranchName` throws on an issue number the convention cannot
 * express; that is a preview, not the create request, so it must degrade to
 * showing nothing rather than take the modal down with it.
 */
export function issueBranchPreview(issue: Pick<RepoIssue, "number" | "title">): string | null {
  try {
    return issueBranchName(issue);
  } catch {
    return null;
  }
}

/** Everything the form holds that decides what gets sent. */
export interface CreateWorkspaceForm {
  readonly ship: string;
  readonly repoName: string;
  readonly name: string;
  /** Whether the "Create from issue" checkbox is ticked. */
  readonly fromIssue: boolean;
  readonly branch: string;
  readonly issue: RepoIssue | null;
}

/** The body of `POST /workspaces`; the two branch sources are mutually exclusive. */
export interface CreateWorkspaceInput {
  readonly ship: string;
  readonly repoName: string;
  readonly name: string;
  readonly branch?: string;
  readonly issueNumber?: number;
}

/**
 * The request a filled-in form amounts to, or `null` when it is not submittable.
 *
 * One function rather than a payload builder plus a `canSubmit` predicate: they
 * would be two statements of the same rules, free to disagree, and the disagreement
 * would show up as a request the bridge rejects. In particular the issue-mode
 * result carries **no `branch` key at all** — the bridge answers 400 to a body
 * naming both sources, and an empty string is naming one.
 */
export function createWorkspaceInput(form: CreateWorkspaceForm): CreateWorkspaceInput | null {
  const name = form.name.trim();
  if (name.length === 0 || form.ship.length === 0) return null;

  if (form.fromIssue) {
    if (!form.issue) return null;
    return { ship: form.ship, repoName: form.repoName, name, issueNumber: form.issue.number };
  }

  const branch = form.branch.trim();
  if (branch.length === 0) return null;
  return { ship: form.ship, repoName: form.repoName, name, branch };
}
