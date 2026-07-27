/**
 * src/issue-branch.ts — the canonical branch name for an issue.
 *
 * Reproduces the convention GitHub itself uses when you create a branch from an
 * issue ("Development → create a branch"): `<number>-<slug of title>`.
 *
 * It lives in the shared protocol package, rather than in the bridge, so that a
 * client can render a preview of the name *before* submitting a create request
 * while the bridge computes the same name authoritatively — one implementation,
 * so the two can never disagree about what the user was shown.
 */

/**
 * Longest name this produces. Not a git limit (git allows far more): it keeps
 * the resulting workspace/branch readable in a list and well inside the
 * `FleetIdentifier` byte budget, since the output is pure ASCII.
 */
const MAX_LENGTH = 60;

/**
 * `<number>-<slug of title>`, e.g. `12-better-create-workspace-issue`. The slug
 * lowercases the title and collapses every run of non-`[a-z0-9]` into a single
 * `-`; a title with no Latin alphanumerics at all yields just `<number>`.
 *
 * The result is always a legal git branch name and a valid `FleetIdentifier`.
 * Throws when `number` is not a positive *safe* integer — nothing downstream can
 * make sense of a branch pointing at an issue that cannot exist, and past
 * `Number.MAX_SAFE_INTEGER` the number stringifies to exponential notation
 * (`1e+21`), which is not the documented `<number>-<slug>` shape at all.
 */
export function issueBranchName(issue: { number: number; title: string }): string {
  if (!Number.isSafeInteger(issue.number) || issue.number < 1) {
    throw new Error(`issue number must be a positive integer, got ${issue.number}`);
  }

  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = slug.length === 0 ? String(issue.number) : `${issue.number}-${slug}`;
  if (name.length <= MAX_LENGTH) return name;
  // Truncation can land mid-word and leave the separator dangling; a trailing
  // "-" is legal in git but reads as a mistake, so it goes.
  return name.slice(0, MAX_LENGTH).replace(/-+$/, "");
}
