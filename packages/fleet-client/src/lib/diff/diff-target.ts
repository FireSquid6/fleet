/**
 * diff-target.ts — what the diff viewer is pointed at, and how that becomes a
 * bridge `GET /workspaces/:repo/:name/diff` query.
 *
 * Three targets cover what a reviewer of an agent's workspace needs to see:
 * the uncommitted work in the tree, everything the branch has done relative to
 * another branch, and the tail end of the branch's own history.
 */

export type DiffTarget =
  | { kind: "working" }
  | { kind: "branch"; base: string; includeWorking: boolean }
  | { kind: "commits"; count: number };

/** Query parameters accepted by the diff route (a subset of git-bun's `DiffOptions`). */
export interface DiffQuery {
  range: string;
  mergeBase?: boolean;
  includeUntracked?: boolean;
}

export const DEFAULT_COMMIT_COUNT = 3;

/** Upper bound on "last N commits" — the ship lists this many commits in `refs`. */
export const MAX_COMMIT_COUNT = 20;

export function clampCommitCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_COMMIT_COUNT;
  return Math.min(MAX_COMMIT_COUNT, Math.max(1, Math.trunc(count)));
}

export function diffQuery(target: DiffTarget): DiffQuery {
  switch (target.kind) {
    // `HEAD` covers staged and unstaged changes alike; untracked files are
    // synthesized into add-file patches by the ship.
    case "working":
      return { range: "HEAD", includeUntracked: true };
    // `base...HEAD` stops at the HEAD commit, so the working tree is only in the
    // diff via the merge-base form — see `DiffOptions.mergeBase` in git-bun.
    case "branch":
      return target.includeWorking
        ? { range: target.base, mergeBase: true, includeUntracked: true }
        : { range: `${target.base}...HEAD` };
    // Two-dot against an ancestor commit: the last N commits *and* whatever is
    // still uncommitted on top of them.
    case "commits":
      return { range: `HEAD~${clampCommitCount(target.count)}`, includeUntracked: true };
  }
}

/** Human-facing summary of a target, shown in the toolbar and the empty state. */
export function describeDiffTarget(target: DiffTarget): string {
  switch (target.kind) {
    case "working":
      return "uncommitted changes";
    case "branch":
      return target.includeWorking
        ? `this branch vs ${target.base}, including uncommitted work`
        : `commits on this branch since ${target.base}`;
    case "commits": {
      const count = clampCommitCount(target.count);
      return `last ${count} commit${count === 1 ? "" : "s"} plus uncommitted work`;
    }
  }
}
