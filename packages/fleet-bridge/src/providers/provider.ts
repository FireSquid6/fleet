/**
 * providers/provider.ts — the framework-free `RepoProvider` abstraction.
 *
 * The bridge only knows GitHub today, but a repo's `provider` field already
 * admits "gitlab"/"custom". This module defines a host-agnostic interface and a
 * clean set of DTOs so the rest of the bridge can query issues/PRs without
 * touching any single forge's REST shapes. Like `types.ts`, these result types
 * are plain TypeScript (consumed through Elysia/Eden inference), not zod schemas.
 *
 * `ProviderError` deliberately mirrors — but does not import — the manager's
 * `BridgeError`: the provider layer stays free of the HTTP framework, and a
 * later step maps its `status` onto the API's error responses.
 */

/** An HTTP-shaped provider failure; `status` is the status a route should surface. */
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

export interface RepoProvider {
  getInfo(): Promise<RepoInfo>;
  listIssues(options?: ListOptions): Promise<IssueSummary[]>;
  getIssue(number: number): Promise<Issue>;
  listPullRequests(options?: ListOptions): Promise<PullRequestSummary[]>;
  getPullRequest(number: number): Promise<PullRequest>;
  commentOnIssue(number: number, body: string): Promise<IssueComment>;
  commentOnPullRequest(number: number, body: string): Promise<IssueComment>;
  reviewPullRequest(number: number, review: { event: ReviewEvent; body?: string }): Promise<Review>;
}
