import { Octokit } from "@octokit/rest";
import type { CodeRepository, PullRequest, Issue, Comment, CheckRun, Release } from "./index";

export class GitHubRepository implements CodeRepository {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(params: { token: string; owner: string; repo: string }) {
    this.octokit = new Octokit({ auth: params.token });
    this.owner = params.owner;
    this.repo = params.repo;
  }

  getProvider(): string {
    return "github";
  }

  // Pull Requests

  async listPullRequests(state: "open" | "closed" | "all" = "open"): Promise<PullRequest[]> {
    const { data } = await this.octokit.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state,
    });
    return data.map(this.mapPullRequest);
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
    });
    return this.mapPullRequest(data);
  }

  async createPullRequest(params: {
    title: string;
    body: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: params.title,
      body: params.body,
      head: params.sourceBranch,
      base: params.targetBranch,
    });
    return this.mapPullRequest(data);
  }

  async mergePullRequest(number: number): Promise<void> {
    await this.octokit.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
    });
  }

  async closePullRequest(number: number): Promise<void> {
    await this.octokit.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      state: "closed",
    });
  }

  async listPullRequestComments(number: number): Promise<Comment[]> {
    const { data } = await this.octokit.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });
    return data.map(this.mapComment);
  }

  async addPullRequestComment(number: number, body: string): Promise<Comment> {
    const { data } = await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      body,
    });
    return this.mapComment(data);
  }

  // Issues

  async listIssues(state: "open" | "closed" | "all" = "open"): Promise<Issue[]> {
    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state,
    });
    // GitHub returns PRs in the issues list; filter them out
    return data.filter(i => !i.pull_request).map(this.mapIssue);
  }

  async getIssue(number: number): Promise<Issue> {
    const { data } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });
    return this.mapIssue(data);
  }

  async createIssue(params: { title: string; body: string; labels?: string[] }): Promise<Issue> {
    const { data } = await this.octokit.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: params.title,
      body: params.body,
      labels: params.labels,
    });
    return this.mapIssue(data);
  }

  async closeIssue(number: number): Promise<void> {
    await this.octokit.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      state: "closed",
    });
  }

  async addIssueComment(number: number, body: string): Promise<Comment> {
    const { data } = await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      body,
    });
    return this.mapComment(data);
  }

  // CI / Checks

  async listCheckRuns(ref: string): Promise<CheckRun[]> {
    const { data } = await this.octokit.checks.listForRef({
      owner: this.owner,
      repo: this.repo,
      ref,
    });
    return data.check_runs.map(run => ({
      name: run.name,
      status: run.status as CheckRun["status"],
      conclusion: (run.conclusion ?? null) as CheckRun["conclusion"],
      url: run.html_url ?? run.url,
    }));
  }

  // Releases

  async createRelease(params: {
    tagName: string;
    name: string;
    body: string;
    targetBranch?: string;
  }): Promise<Release> {
    const { data } = await this.octokit.repos.createRelease({
      owner: this.owner,
      repo: this.repo,
      tag_name: params.tagName,
      name: params.name,
      body: params.body,
      target_commitish: params.targetBranch,
    });
    return {
      id: data.id,
      tagName: data.tag_name,
      name: data.name ?? params.name,
      body: data.body ?? params.body,
      url: data.html_url,
    };
  }

  // Mappers

  private mapPullRequest(pr: {
    number: number;
    title: string;
    body?: string | null;
    state: string;
    merged_at?: string | null;
    head: { ref: string };
    base: { ref: string };
    html_url: string;
    user?: { login: string } | null;
  }): PullRequest {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.merged_at ? "merged" : (pr.state as "open" | "closed"),
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      url: pr.html_url,
      author: pr.user?.login ?? "",
    };
  }

  private mapIssue(issue: {
    number: number;
    title: string;
    body?: string | null;
    state: string;
    labels: Array<{ name?: string } | string>;
    html_url: string;
    user?: { login: string } | null;
  }): Issue {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state as "open" | "closed",
      labels: issue.labels.map(l => (typeof l === "string" ? l : (l.name ?? ""))),
      url: issue.html_url,
      author: issue.user?.login ?? "",
    };
  }

  private mapComment(comment: {
    id: number;
    body?: string | null;
    user?: { login: string } | null;
    created_at: string;
  }): Comment {
    return {
      id: comment.id,
      body: comment.body ?? "",
      author: comment.user?.login ?? "",
      createdAt: comment.created_at,
    };
  }
}
