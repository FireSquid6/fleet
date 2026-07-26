/**
 * format.ts — pure formatting helpers for `fagent repo` output (no network,
 * no I/O). `renderTable` is copied from the fleet CLI (apps don't depend on
 * each other); the repo formatters are typed against the bridge's provider DTOs.
 */

import type {
  Issue,
  IssueSummary,
  PullRequest,
  PullRequestSummary,
  RepoInfo,
} from "fleet-bridge/providers";

/**
 * Render an aligned, human-readable table: a header row followed by one row per
 * entry, each column padded to its widest cell. With no rows, only the header is
 * returned.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length)),
  );

  const formatRow = (cells: readonly string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd();

  return [formatRow(headers), ...rows.map((row) => formatRow(row))].join("\n");
}

/**
 * Render a timestamp field as ISO text. The bridge sends timestamps as ISO-8601
 * strings, but Eden's Treaty client auto-parses ISO strings in responses into
 * `Date` objects, so the DTO's declared `string` may arrive as a `Date`.
 */
function isoText(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Render a repo's metadata as aligned `key: value` lines. */
export function formatRepoInfo(info: RepoInfo): string {
  const lines: [string, string][] = [
    ["fullName", info.fullName],
    ["description", info.description ?? ""],
    ["url", info.url],
    ["defaultBranch", info.defaultBranch],
    ["private", String(info.private)],
    ["stars", String(info.stars)],
    ["openIssues", String(info.openIssues)],
  ];
  const width = Math.max(...lines.map(([key]) => key.length));
  return lines.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

/** Render a list of issue summaries as a table. */
export function formatIssueList(issues: IssueSummary[]): string {
  return renderTable(
    ["#", "TITLE", "STATE", "AUTHOR", "UPDATED"],
    issues.map((issue) => [
      String(issue.number),
      issue.title,
      issue.state,
      issue.author ?? "",
      isoText(issue.updatedAt),
    ]),
  );
}

/** Render a single issue as a detail block: header, metadata, then the body. */
export function formatIssue(issue: Issue): string {
  return [
    `#${issue.number} ${issue.title}`,
    `state:    ${issue.state}`,
    `author:   ${issue.author ?? ""}`,
    `url:      ${issue.url}`,
    `created:  ${isoText(issue.createdAt)}`,
    `updated:  ${isoText(issue.updatedAt)}`,
    `comments: ${issue.comments}`,
    "",
    issue.body ?? "(no description)",
  ].join("\n");
}

/** Render a list of pull request summaries as a table. */
export function formatPrList(prs: PullRequestSummary[]): string {
  return renderTable(
    ["#", "TITLE", "STATE", "AUTHOR", "BASE←HEAD", "DRAFT"],
    prs.map((pr) => [
      String(pr.number),
      pr.title,
      pr.state,
      pr.author ?? "",
      `${pr.baseBranch}←${pr.headBranch}`,
      String(pr.draft),
    ]),
  );
}

/** Render a single pull request as a detail block: header, metadata, then the body. */
export function formatPr(pr: PullRequest): string {
  return [
    `#${pr.number} ${pr.title}`,
    `state:     ${pr.state}`,
    `author:    ${pr.author ?? ""}`,
    `url:       ${pr.url}`,
    `base←head: ${pr.baseBranch}←${pr.headBranch}`,
    `draft:     ${pr.draft}`,
    `merged:    ${pr.merged}`,
    `mergeable: ${pr.mergeable === null ? "unknown" : pr.mergeable}`,
    `created:   ${isoText(pr.createdAt)}`,
    `updated:   ${isoText(pr.updatedAt)}`,
    `changes:   +${pr.additions} -${pr.deletions} (${pr.changedFiles} files)`,
    "",
    pr.body ?? "(no description)",
  ].join("\n");
}
