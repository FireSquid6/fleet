/**
 * providers/index.ts — the entry point that builds a `RepoProvider` for a repo.
 *
 * `providerFor` switches on the repo's `provider` string and resolves a token
 * from explicit deps, then the environment (GITHUB_TOKEN, then GH_TOKEN). Only
 * GitHub is wired today; other providers throw a 501 so the API can report that
 * the forge is recognized but not yet implemented. The public provider surface
 * is re-exported here so consumers import everything from one place.
 */

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
  Issue,
  IssueComment,
  IssueSummary,
  ListOptions,
  PullRequest,
  PullRequestSummary,
  RepoInfo,
  RepoProvider,
  Review,
  ReviewEvent,
} from "./provider";
