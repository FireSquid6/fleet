export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  sourceBranch: string;
  targetBranch: string;
  url: string;
  author: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  url: string;
  author: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "neutral" | null;
  url: string;
}

export interface Release {
  id: number;
  tagName: string;
  name: string;
  body: string;
  url: string;
}

export interface CodeRepository {
  getProvider(): string;

  // Pull Requests
  listPullRequests(state?: "open" | "closed" | "all"): Promise<PullRequest[]>;
  getPullRequest(number: number): Promise<PullRequest>;
  createPullRequest(params: {
    title: string;
    body: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<PullRequest>;
  mergePullRequest(number: number): Promise<void>;
  closePullRequest(number: number): Promise<void>;
  listPullRequestComments(number: number): Promise<Comment[]>;
  addPullRequestComment(number: number, body: string): Promise<Comment>;

  // Issues
  listIssues(state?: "open" | "closed" | "all"): Promise<Issue[]>;
  getIssue(number: number): Promise<Issue>;
  createIssue(params: { title: string; body: string; labels?: string[] }): Promise<Issue>;
  closeIssue(number: number): Promise<void>;
  addIssueComment(number: number, body: string): Promise<Comment>;

  // CI / Checks
  listCheckRuns(ref: string): Promise<CheckRun[]>;

  // Releases
  createRelease(params: {
    tagName: string;
    name: string;
    body: string;
    targetBranch?: string;
  }): Promise<Release>;
}
