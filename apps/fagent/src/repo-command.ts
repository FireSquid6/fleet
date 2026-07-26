/**
 * repo-command.ts — the `fagent repo …` command group.
 *
 * Repo operations (info, issues, PRs, comments, reviews) that an agent drives
 * from inside a workspace. Everything flows THROUGH the fleet bridge — fagent
 * never calls GitHub directly. The repo name is auto-detected from the current
 * workspace path (via `findWorkspace`) unless overridden with `--repo`.
 */

import { Command } from "commander";
import type {
  Issue,
  IssueComment,
  IssueSummary,
  PullRequest,
  PullRequestSummary,
  RepoInfo,
  Review,
} from "fleet-bridge/providers";
import { findWorkspace } from "./agent-workspace";
import { makeBridgeClient, normalizeUrl, unwrap } from "./client";
import {
  formatIssue,
  formatIssueList,
  formatPr,
  formatPrList,
  formatRepoInfo,
} from "./format";

type StateFilter = "open" | "closed" | "all" | undefined;

export const repoCommand = new Command()
  .name("repo")
  .description("repo operations for the current workspace, via the fleet bridge")
  .option("--bridge-url <url>", "base URL of the Fleet Bridge", "http://localhost:4800")
  .option("-r, --repo <name>", "repo name (defaults to the auto-detected workspace repo)");

function bridge() {
  return makeBridgeClient(normalizeUrl(repoCommand.opts().bridgeUrl));
}

/**
 * Resolve the repo name to act on: the explicit `--repo`, else the repo of the
 * workspace the CWD lives in. Exits 1 when neither is available.
 */
async function resolveRepo(): Promise<string> {
  const override = repoCommand.opts().repo as string | undefined;
  if (override) return override;

  const location = await findWorkspace();
  if (location) return location.repo;

  console.error("fagent: not inside a fleet workspace (pass --repo <name>)");
  process.exit(1);
}

/** Parse a `<number>` CLI argument as a positive integer, exiting 1 otherwise. */
function parseNumber(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`fagent: invalid number "${value}"`);
    process.exit(1);
  }
  return n;
}

repoCommand
  .command("info")
  .description("show metadata about the repo")
  .action(async () => {
    const name = await resolveRepo();
    const info = unwrap(await bridge().repos({ name }).info.get()) as RepoInfo;
    console.log(formatRepoInfo(info));
  });

const issue = new Command("issue").description("inspect and comment on issues");

issue
  .command("list")
  .description("list issues")
  .option("-s, --state <state>", "filter by state (open|closed|all)")
  .action(async (options: { state?: StateFilter }) => {
    const name = await resolveRepo();
    const issues = unwrap(await bridge().repos({ name }).issues.get({ query: { state: options.state } })) as IssueSummary[];
    console.log(formatIssueList(issues));
  });

issue
  .command("view <number>")
  .description("show a single issue")
  .action(async (value: string) => {
    const name = await resolveRepo();
    const number = parseNumber(value);
    const result = unwrap(await bridge().repos({ name }).issues({ number }).get()) as Issue;
    console.log(formatIssue(result));
  });

issue
  .command("comment <number> <body>")
  .description("comment on an issue")
  .action(async (value: string, body: string) => {
    const name = await resolveRepo();
    const number = parseNumber(value);
    const comment = unwrap(await bridge().repos({ name }).issues({ number }).comments.post({ body })) as IssueComment;
    console.log(`commented on issue #${number}: ${comment.url}`);
  });

repoCommand.addCommand(issue);

const pr = new Command("pr").description("inspect, comment on, and review pull requests");

pr
  .command("list")
  .description("list pull requests")
  .option("-s, --state <state>", "filter by state (open|closed|all)")
  .action(async (options: { state?: StateFilter }) => {
    const name = await resolveRepo();
    const prs = unwrap(await bridge().repos({ name }).pulls.get({ query: { state: options.state } })) as PullRequestSummary[];
    console.log(formatPrList(prs));
  });

pr
  .command("view <number>")
  .description("show a single pull request")
  .action(async (value: string) => {
    const name = await resolveRepo();
    const number = parseNumber(value);
    const result = unwrap(await bridge().repos({ name }).pulls({ number }).get()) as PullRequest;
    console.log(formatPr(result));
  });

pr
  .command("comment <number> <body>")
  .description("comment on a pull request")
  .action(async (value: string, body: string) => {
    const name = await resolveRepo();
    const number = parseNumber(value);
    const comment = unwrap(await bridge().repos({ name }).pulls({ number }).comments.post({ body })) as IssueComment;
    console.log(`commented on pr #${number}: ${comment.url}`);
  });

repoCommand.addCommand(pr);

repoCommand
  .command("review <number>")
  .description("submit a review on a pull request")
  .option("--approve", "approve the pull request")
  .option("--request-changes", "request changes on the pull request")
  .option("--comment", "leave a review comment without a verdict")
  .option("-b, --body <text>", "review body")
  .action(async (value: string, options: { approve?: boolean; requestChanges?: boolean; comment?: boolean; body?: string }) => {
    const chosen = [
      options.approve && ("APPROVE" as const),
      options.requestChanges && ("REQUEST_CHANGES" as const),
      options.comment && ("COMMENT" as const),
    ].filter((event): event is "APPROVE" | "REQUEST_CHANGES" | "COMMENT" => Boolean(event));

    if (chosen.length !== 1) {
      console.error("fagent: choose exactly one of --approve, --request-changes, --comment");
      process.exit(1);
    }
    const event = chosen[0]!;

    const name = await resolveRepo();
    const number = parseNumber(value);
    const review = unwrap(await bridge().repos({ name }).pulls({ number }).reviews.post({ event, body: options.body })) as Review;
    console.log(`submitted ${event} review on pr #${number}: ${review.url}`);
  });
