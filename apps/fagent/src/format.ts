import type {
  CheckRun,
  Issue,
  IssueSummary,
  PullRequest,
  PullRequestSummary,
  RepoInfo,
} from "fleet-bridge/providers";
import { renderTable } from "fleet-cli-kit";

/**
 * The bridge sends timestamps as ISO-8601 strings, but Eden's Treaty client
 * auto-parses ISO strings in responses into `Date` objects, so the DTO's
 * declared `string` may arrive as a `Date`.
 */
function isoText(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

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

export function formatCheckList(checks: CheckRun[]): string {
  return renderTable(
    ["NAME", "STATUS", "CONCLUSION", "DETAILS"],
    checks.map((check) => [
      check.name,
      check.status,
      check.conclusion ?? "",
      check.detailsUrl ?? "",
    ]),
  );
}

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
