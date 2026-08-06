/**
 * An HTTP-shaped provider failure; `status` is the status a route should surface.
 * Mirrors — but deliberately never imports — the manager's `BridgeError`, so the provider layer stays free of the HTTP framework.
 */
export class ProviderError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface RepoInfo {
  readonly name: string;
  readonly fullName: string;
  readonly description: string | null;
  readonly url: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly stars: number;
  readonly openIssues: number;
}

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string | null;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue extends IssueSummary {
  readonly body: string | null;
  readonly comments: number;
}

export interface PullRequestSummary extends IssueSummary {
  readonly draft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
}

export interface PullRequest extends PullRequestSummary {
  readonly body: string | null;
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  /** SHA of the PR's head commit; the ref used to resolve its CI checks/logs. */
  readonly headSha: string;
}

/** A single CI check on a commit — from GitHub Actions or any third-party check. */
export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface FailedJobLog {
  readonly workflow: string;
  readonly job: string;
  readonly jobId: number;
  readonly log: string;
}

export interface IssueComment {
  readonly id: number;
  readonly author: string | null;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
}

export interface Review {
  readonly id: number;
  readonly state: string;
  readonly author: string | null;
  readonly body: string;
  readonly url: string;
}

/** Filter for list endpoints; the implementation defaults an omitted `state` to "open". */
export interface ListOptions {
  readonly state?: "open" | "closed" | "all";
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** A branch the provider created and attached to an issue. */
export interface LinkedBranch {
  readonly name: string;
  readonly sha: string;
}

export interface RepoProvider {
  getInfo(): Promise<RepoInfo>;
  listIssues(options?: ListOptions): Promise<IssueSummary[]>;
  getIssue(number: number): Promise<Issue>;
  listPullRequests(options?: ListOptions): Promise<PullRequestSummary[]>;
  /**
   * Every pull request, open or closed, whose head is `branch` on this repo.
   * Unlike {@link listPullRequests} the answer is complete, so a caller may read
   * "none are open" from it.
   */
  pullRequestsForBranch(branch: string): Promise<PullRequestSummary[]>;
  getPullRequest(number: number): Promise<PullRequest>;
  commentOnIssue(number: number, body: string): Promise<IssueComment>;
  commentOnPullRequest(number: number, body: string): Promise<IssueComment>;
  reviewPullRequest(number: number, review: { event: ReviewEvent; body?: string }): Promise<Review>;
  /** CI checks on a commit-ish (branch name, tag, or SHA). */
  listChecks(ref: string): Promise<CheckRun[]>;
  /** Raw logs of the failed GitHub Actions jobs for a commit-ish. */
  getFailedLogs(ref: string): Promise<FailedJobLog[]>;
  /**
   * Create `branch` on the remote *and* record it as the issue's linked
   * development branch (GitHub's "Development → create a branch for this issue"
   * relationship). A write: it needs a token with repo write scope.
   *
   * Callers must use the returned `name`, never the one they passed in: a forge
   * may hand back a different ref. What any given forge does when the name is
   * already taken — de-duplicate it, refuse, or return the existing link — is
   * not established here, so an implementation is expected to cope with the name
   * coming back changed and to be safe to call twice for the same branch.
   */
  linkBranchToIssue(issueNumber: number, branch: string): Promise<LinkedBranch>;
}
