import { tool } from "ai";
import { z } from "zod";
import type { CodeRepository } from "../code-repository";

export function getToolkitFromCodeRepository(repo: CodeRepository) {
  return {
    repoGetProvider: tool({
      description: "Get the name of the code hosting provider (e.g. 'github')",
      inputSchema: z.object({}),
      execute: async () => repo.getProvider(),
    }),

    repoListPullRequests: tool({
      description: "List pull requests in the repository",
      inputSchema: z.object({
        state: z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state (default: open)"),
      }),
      execute: async ({ state }) => repo.listPullRequests(state),
    }),

    repoGetPullRequest: tool({
      description: "Get a single pull request by number",
      inputSchema: z.object({
        number: z.number().describe("Pull request number"),
      }),
      execute: async ({ number }) => repo.getPullRequest(number),
    }),

    repoCreatePullRequest: tool({
      description: "Create a new pull request",
      inputSchema: z.object({
        title: z.string().describe("PR title"),
        body: z.string().describe("PR description"),
        sourceBranch: z.string().describe("Branch to merge from"),
        targetBranch: z.string().describe("Branch to merge into"),
      }),
      execute: async (params) => repo.createPullRequest(params),
    }),

    repoMergePullRequest: tool({
      description: "Merge a pull request",
      inputSchema: z.object({
        number: z.number().describe("Pull request number"),
      }),
      execute: async ({ number }) => repo.mergePullRequest(number),
    }),

    repoClosePullRequest: tool({
      description: "Close a pull request without merging",
      inputSchema: z.object({
        number: z.number().describe("Pull request number"),
      }),
      execute: async ({ number }) => repo.closePullRequest(number),
    }),

    repoListPullRequestComments: tool({
      description: "List comments on a pull request",
      inputSchema: z.object({
        number: z.number().describe("Pull request number"),
      }),
      execute: async ({ number }) => repo.listPullRequestComments(number),
    }),

    repoAddPullRequestComment: tool({
      description: "Post a comment on a pull request",
      inputSchema: z.object({
        number: z.number().describe("Pull request number"),
        body: z.string().describe("Comment text"),
      }),
      execute: async ({ number, body }) => repo.addPullRequestComment(number, body),
    }),

    repoListIssues: tool({
      description: "List issues in the repository",
      inputSchema: z.object({
        state: z.enum(["open", "closed", "all"]).optional().describe("Filter by issue state (default: open)"),
      }),
      execute: async ({ state }) => repo.listIssues(state),
    }),

    repoGetIssue: tool({
      description: "Get a single issue by number",
      inputSchema: z.object({
        number: z.number().describe("Issue number"),
      }),
      execute: async ({ number }) => repo.getIssue(number),
    }),

    repoCreateIssue: tool({
      description: "Create a new issue",
      inputSchema: z.object({
        title: z.string().describe("Issue title"),
        body: z.string().describe("Issue description"),
        labels: z.array(z.string()).optional().describe("Labels to apply"),
      }),
      execute: async (params) => repo.createIssue(params),
    }),

    repoCloseIssue: tool({
      description: "Close an issue",
      inputSchema: z.object({
        number: z.number().describe("Issue number"),
      }),
      execute: async ({ number }) => repo.closeIssue(number),
    }),

    repoAddIssueComment: tool({
      description: "Post a comment on an issue",
      inputSchema: z.object({
        number: z.number().describe("Issue number"),
        body: z.string().describe("Comment text"),
      }),
      execute: async ({ number, body }) => repo.addIssueComment(number, body),
    }),

    repoListCheckRuns: tool({
      description: "List CI check runs for a commit ref (SHA, branch, or tag)",
      inputSchema: z.object({
        ref: z.string().describe("Commit SHA, branch name, or tag name"),
      }),
      execute: async ({ ref }) => repo.listCheckRuns(ref),
    }),

    repoCreateRelease: tool({
      description: "Create a release with a tag",
      inputSchema: z.object({
        tagName: z.string().describe("Tag name for the release"),
        name: z.string().describe("Release title"),
        body: z.string().describe("Release notes"),
        targetBranch: z.string().optional().describe("Branch or commit to tag (default: repo default branch)"),
      }),
      execute: async (params) => repo.createRelease(params),
    }),
  };
}
