import type { Repo } from "fleet-protocol";
import { GitHubProvider, parseGitHubRepo } from "./github";
import { ProviderError, type RepoProvider } from "./provider";

export interface ProviderDeps {
  fetch?: typeof fetch;
  token?: string;
  env?: Record<string, string | undefined>;
}

export function providerFor(repo: Repo, deps?: ProviderDeps): RepoProvider {
  const env = deps?.env ?? process.env;
  const token = deps?.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;

  switch (repo.provider.toLowerCase()) {
    case "github": {
      const { owner, repo: name } = parseGitHubRepo(repo.url);
      return new GitHubProvider({ owner, repo: name, token, fetch: deps?.fetch });
    }
    default:
      throw new ProviderError(`provider "${repo.provider}" is not supported yet`, 501);
  }
}

export { GitHubProvider, parseGitHubRepo } from "./github";
export type { GitHubProviderConfig } from "./github";
export {
  ProviderError,
} from "./provider";
export type {
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
