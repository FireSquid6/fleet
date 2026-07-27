/**
 * providers/github.ts — a `RepoProvider` backed by GitHub's REST API v3.
 *
 * Every dependency (owner/repo, token, `fetch`, base URL) is injected through
 * the constructor so the provider is exercisable in unit tests without env vars
 * or the network. GitHub's `/issues` endpoint also returns pull requests, so
 * `listIssues` filters out any element carrying a `pull_request` key to keep the
 * two streams distinct. Write operations require a token — GitHub cannot accept
 * anonymous comments/reviews — so those methods reject early with a 401.
 */

import type {
  CheckRun,
  FailedJobLog,
  Issue,
  IssueComment,
  IssueSummary,
  LinkedBranch,
  ListOptions,
  PullRequest,
  PullRequestSummary,
  RepoInfo,
  RepoProvider,
  Review,
  ReviewEvent,
} from "./provider";
import { ProviderError } from "./provider";

export interface GitHubProviderConfig {
  owner: string;
  repo: string;
  token?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.github.com";

/**
 * The only way to attach a branch to an issue: GitHub exposes the linkage
 * through GraphQL alone, with no REST equivalent. The mutation creates the ref
 * as well, so nothing has to push a branch beforehand.
 */
const CREATE_LINKED_BRANCH = `mutation CreateLinkedBranch($issueId: ID!, $oid: GitObjectID!, $name: String!) {
  createLinkedBranch(input: { issueId: $issueId, oid: $oid, name: $name }) {
    linkedBranch {
      ref {
        name
        target { oid }
      }
    }
  }
}`;

/**
 * The branches already attached to an issue, used to make `linkBranchToIssue`
 * idempotent. `first: 10` is generous: GitHub's own UI links one branch per
 * issue, and only a human linking branches by hand pushes it past that.
 */
const LINKED_BRANCHES = `query LinkedBranches($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      linkedBranches(first: 10) {
        nodes {
          ref {
            name
            target { oid }
          }
        }
      }
    }
  }
}`;

/**
 * Extract `{ owner, repo }` from a git clone URL. Handles the https web form
 * (with or without a `.git` suffix or trailing slash) and the `git@host:o/r.git`
 * SSH form. Throws `ProviderError` (400) when neither shape matches.
 */
export function parseGitHubRepo(url: string): { owner: string; repo: string } {
  const trimmed = url.trim();

  const ssh = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh?.[1] && ssh[2]) {
    return { owner: ssh[1], repo: ssh[2] };
  }

  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https?.[1] && https[2]) {
    return { owner: https[1], repo: https[2] };
  }

  throw new ProviderError(`could not parse GitHub repo from URL: ${url}`, 400);
}

/** GitHub's user object; `login` is the handle we surface as `author`. */
interface GitHubUser {
  login: string;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  private: boolean;
  stargazers_count: number;
  open_issues_count: number;
}

interface GitHubIssue {
  number: number;
  /** GraphQL global id — the handle `createLinkedBranch` addresses the issue by. */
  node_id?: string;
  title: string;
  state: string;
  user: GitHubUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  body: string | null;
  comments: number;
  pull_request?: unknown;
}

interface GitHubPull {
  number: number;
  title: string;
  state: string;
  user: GitHubUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  base: { ref: string };
  head: { ref: string; sha: string };
  body: string | null;
  merged: boolean;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changed_files: number;
}

interface GitHubComment {
  id: number;
  user: GitHubUser | null;
  body: string;
  html_url: string;
  created_at: string;
}

interface GitHubReview {
  id: number;
  state: string;
  user: GitHubUser | null;
  body: string;
  html_url: string;
}

interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface GitHubWorkflowRun {
  id: number;
  name: string;
}

interface GitHubJob {
  id: number;
  name: string;
  conclusion: string | null;
}

interface GitHubRef {
  object?: { sha?: string };
}

/** Envelope of a GraphQL reply; `errors` can be present alongside HTTP 200. */
interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: unknown }[];
}

/** The `{ name, target { oid } }` selection both linked-branch operations share. */
interface GraphQLRef {
  name?: string;
  target?: { oid?: string } | null;
}

interface CreateLinkedBranchResult {
  createLinkedBranch?: {
    linkedBranch?: { ref?: GraphQLRef | null } | null;
  } | null;
}

interface LinkedBranchesResult {
  repository?: {
    issue?: {
      linkedBranches?: { nodes?: ({ ref?: GraphQLRef | null } | null)[] | null } | null;
    } | null;
  } | null;
}

/** A ref selection that carries both fields, or `undefined` if it does not. */
function toLinkedBranch(ref: GraphQLRef | null | undefined): LinkedBranch | undefined {
  if (!ref?.name || !ref.target?.oid) return undefined;
  return { name: ref.name, sha: ref.target.oid };
}

export class GitHubProvider implements RepoProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(config: GitHubProviderConfig) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token;
    this.fetchImpl = config.fetch ?? fetch;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async getInfo(): Promise<RepoInfo> {
    const repo = await this.request<GitHubRepo>(`/repos/${this.owner}/${this.repo}`);
    return {
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      private: repo.private,
      stars: repo.stargazers_count,
      openIssues: repo.open_issues_count,
    };
  }

  async listIssues(options?: ListOptions): Promise<IssueSummary[]> {
    const state = options?.state ?? "open";
    // GitHub pages at 30 by default and says nothing about the truncation. The
    // list feeds a search-over-all-issues picker, so 100 — the maximum a single
    // page allows — is the difference between "no matches" and the issue.
    const issues = await this.request<GitHubIssue[]>(
      `/repos/${this.owner}/${this.repo}/issues?state=${state}&per_page=100`,
    );
    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => this.toIssueSummary(issue));
  }

  async getIssue(number: number): Promise<Issue> {
    const issue = await this.request<GitHubIssue>(
      `/repos/${this.owner}/${this.repo}/issues/${number}`,
    );
    return {
      ...this.toIssueSummary(issue),
      body: issue.body,
      comments: issue.comments,
    };
  }

  async listPullRequests(options?: ListOptions): Promise<PullRequestSummary[]> {
    const state = options?.state ?? "open";
    const pulls = await this.request<GitHubPull[]>(
      `/repos/${this.owner}/${this.repo}/pulls?state=${state}`,
    );
    return pulls.map((pull) => this.toPullRequestSummary(pull));
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const pull = await this.request<GitHubPull>(
      `/repos/${this.owner}/${this.repo}/pulls/${number}`,
    );
    return {
      ...this.toPullRequestSummary(pull),
      body: pull.body,
      merged: pull.merged,
      mergeable: pull.mergeable,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      headSha: pull.head.sha,
    };
  }

  async commentOnIssue(number: number, body: string): Promise<IssueComment> {
    return this.postComment(number, body);
  }

  // PR conversation comments are issue comments on GitHub, so both routes share one endpoint.
  async commentOnPullRequest(number: number, body: string): Promise<IssueComment> {
    return this.postComment(number, body);
  }

  async reviewPullRequest(
    number: number,
    review: { event: ReviewEvent; body?: string },
  ): Promise<Review> {
    this.requireToken();
    const created = await this.request<GitHubReview>(
      `/repos/${this.owner}/${this.repo}/pulls/${number}/reviews`,
      { method: "POST", body: { event: review.event, body: review.body } },
    );
    return {
      id: created.id,
      state: created.state,
      author: created.user?.login ?? null,
      body: created.body,
      url: created.html_url,
    };
  }

  async listChecks(ref: string): Promise<CheckRun[]> {
    const result = await this.request<{ check_runs: GitHubCheckRun[] }>(
      `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}/check-runs`,
    );
    return result.check_runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.details_url,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    }));
  }

  async getFailedLogs(ref: string): Promise<FailedJobLog[]> {
    // Downloading Actions logs is authenticated even on public repos.
    this.requireToken();

    const commit = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}`,
    );
    const sha = commit.sha;

    const runs = await this.request<{ workflow_runs: GitHubWorkflowRun[] }>(
      `/repos/${this.owner}/${this.repo}/actions/runs?head_sha=${sha}`,
    );

    if (runs.workflow_runs.length === 0) {
      // No Actions runs: distinguish "third-party check failed (no logs here)"
      // from "nothing failed" so the caller gets an actionable answer.
      const checks = await this.listChecks(ref);
      const failed = checks.some((check) => check.conclusion === "failure");
      if (failed) {
        throw new ProviderError(
          `no GitHub Actions runs for ${ref}; failing checks are not Actions-backed, so logs are not retrievable via the API`,
          415,
        );
      }
      return [];
    }

    const logs: FailedJobLog[] = [];
    for (const run of runs.workflow_runs) {
      const jobsResult = await this.request<{ jobs: GitHubJob[] }>(
        `/repos/${this.owner}/${this.repo}/actions/runs/${run.id}/jobs`,
      );
      for (const job of jobsResult.jobs) {
        if (job.conclusion !== "failure") continue;
        const log = await this.downloadText(
          `/repos/${this.owner}/${this.repo}/actions/jobs/${job.id}/logs`,
        );
        logs.push({ workflow: run.name, job: job.name, jobId: job.id, log });
      }
    }
    return logs;
  }

  /**
   * Create `branch` off the default branch's head and record it as issue
   * `issueNumber`'s linked development branch, in one mutation. Needs a token
   * with repo write scope: it writes a ref and an issue timeline entry.
   *
   * Three reads precede the write because the mutation is addressed by GraphQL
   * node id and a commit oid, neither of which the caller has: the issue's
   * `node_id`, the repo's default branch, and that branch's head SHA.
   *
   * Idempotent by design — asking twice for the same branch is ordinary (a
   * second workspace off one issue, a retry after a failed clone, or a branch
   * someone already made with `gh issue develop`). GitHub signals "that is
   * already linked" in two different ways depending on the case, and neither is
   * a real failure, so both fall back to {@link linkedBranch}: whatever is
   * attached to the issue now is what the caller wanted.
   */
  async linkBranchToIssue(issueNumber: number, branch: string): Promise<LinkedBranch> {
    this.requireToken();

    const issue = await this.request<GitHubIssue>(
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
    );
    if (!issue.node_id) {
      throw new ProviderError(`GitHub issue ${issueNumber} carried no node id`, 502);
    }

    const { defaultBranch } = await this.getInfo();
    // Not URL-encoded: a default branch may legitimately contain "/", which is a
    // path separator in the ref endpoint rather than data.
    const base = await this.request<GitHubRef>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${defaultBranch}`,
    );
    if (!base.object?.sha) {
      throw new ProviderError(`GitHub returned no head commit for branch ${defaultBranch}`, 502);
    }

    let result: CreateLinkedBranchResult;
    try {
      result = await this.graphql<CreateLinkedBranchResult>(CREATE_LINKED_BRANCH, {
        issueId: issue.node_id,
        oid: base.object.sha,
        name: branch,
      });
    } catch (error) {
      // Shape 1: a populated `errors` array saying the name is taken.
      if (error instanceof ProviderError && error.status === 422) {
        return this.linkedBranch(issueNumber, branch);
      }
      throw error;
    }

    const created = toLinkedBranch(result.createLinkedBranch?.linkedBranch?.ref);
    // Shape 2: HTTP 200, no `errors` at all, and a null `linkedBranch`.
    return created ?? (await this.linkedBranch(issueNumber, branch));
  }

  /**
   * The branch already standing in for a failed `createLinkedBranch`: whichever
   * branch the issue is linked to (preferring `requested`, since a second caller
   * asking for the same name should get that one back), or — for a branch that
   * exists but was never linked — the ref itself.
   *
   * Only when neither turns anything up has nothing actually been created, and
   * the 409 says which name collided rather than blaming the upstream.
   */
  private async linkedBranch(issueNumber: number, requested: string): Promise<LinkedBranch> {
    const result = await this.graphql<LinkedBranchesResult>(LINKED_BRANCHES, {
      owner: this.owner,
      repo: this.repo,
      number: issueNumber,
    });
    const linked = (result.repository?.issue?.linkedBranches?.nodes ?? [])
      .map((node) => toLinkedBranch(node?.ref))
      .filter((ref): ref is LinkedBranch => ref !== undefined);
    const match = linked.find((ref) => ref.name === requested) ?? linked[0];
    if (match) return match;

    try {
      const ref = await this.request<GitHubRef>(
        `/repos/${this.owner}/${this.repo}/git/ref/heads/${requested}`,
      );
      if (ref.object?.sha) return { name: requested, sha: ref.object.sha };
    } catch {
      // A 404 here just means the branch is not there either; fall through to
      // the collision report, which is the more useful message.
    }

    throw new ProviderError(
      `GitHub would not create branch "${requested}" for issue ${issueNumber}, and neither that branch nor a branch linked to the issue exists`,
      409,
    );
  }

  private async postComment(number: number, body: string): Promise<IssueComment> {
    this.requireToken();
    const comment = await this.request<GitHubComment>(
      `/repos/${this.owner}/${this.repo}/issues/${number}/comments`,
      { method: "POST", body: { body } },
    );
    return {
      id: comment.id,
      author: comment.user?.login ?? null,
      body: comment.body,
      url: comment.html_url,
      createdAt: comment.created_at,
    };
  }

  private toIssueSummary(issue: GitHubIssue): IssueSummary {
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login ?? null,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    };
  }

  private toPullRequestSummary(pull: GitHubPull): PullRequestSummary {
    return {
      number: pull.number,
      title: pull.title,
      state: pull.state,
      author: pull.user?.login ?? null,
      url: pull.html_url,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      draft: pull.draft,
      baseBranch: pull.base.ref,
      headBranch: pull.head.ref,
    };
  }

  private requireToken(): void {
    if (!this.token) {
      throw new ProviderError("authentication required: a GitHub token is needed for write operations", 401);
    }
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "fleet-bridge",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (init?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if (!response.ok) {
      throw await this.toProviderError(response);
    }

    return (await response.json()) as T;
  }

  /**
   * Run a GraphQL operation through `request`, so it shares the REST path's
   * headers, auth and failure mapping. GraphQL reports *operation* failures with
   * HTTP 200 and a populated `errors` array, so a transport success still has to
   * be inspected before the payload can be trusted.
   */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const payload = await this.request<GraphQLResponse<T>>("/graphql", {
      method: "POST",
      body: { query, variables },
    });

    const first = payload.errors?.[0];
    if (first !== undefined) {
      const message = typeof first.message === "string" ? first.message : "unknown GraphQL error";
      // GraphQL has no status of its own, so a name collision has to be
      // recognized from the message text. 422 is what `linkBranchToIssue` reads
      // as "already there, go and find it"; it never reaches a client.
      const status = /already exists/i.test(message) ? 422 : 502;
      throw new ProviderError(`GitHub GraphQL request failed: ${message}`, status);
    }
    if (payload.data === undefined || payload.data === null) {
      throw new ProviderError("GitHub GraphQL response carried no data", 502);
    }
    return payload.data;
  }

  /**
   * Fetch a non-JSON body (Actions job logs). GitHub answers the logs endpoint
   * with a 302 to a pre-signed storage URL that rejects the `Authorization`
   * header, so we follow the redirect manually and re-fetch the location with no
   * auth headers at all.
   */
  private async downloadText(path: string): Promise<string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "fleet-bridge",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers, redirect: "manual" });

    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) {
        throw new ProviderError(`GitHub redirect for ${path} carried no Location header`, 502);
      }
      response = await this.fetchImpl(location);
    }

    if (!response.ok) {
      throw await this.toProviderError(response);
    }

    return response.text();
  }

  /** Map an upstream failure onto a `ProviderError`, folding all 5xx down to 502. */
  private async toProviderError(response: Response): Promise<ProviderError> {
    const status = response.status >= 500 ? 502 : response.status;
    let detail = "";
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload?.message === "string") {
        detail = `: ${payload.message}`;
      }
    } catch {
      // Non-JSON error bodies carry no structured message; the status still tells the story.
    }
    return new ProviderError(`GitHub request failed (${response.status})${detail}`, status);
  }
}
