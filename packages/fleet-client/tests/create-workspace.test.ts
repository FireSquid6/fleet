/**
 * create-workspace.test.ts — the decisions the create-workspace form makes: what
 * it says about the branch the user typed, and what request the form amounts to.
 * There is no DOM harness in this package, so this is where the form's logic is
 * held to account; the component around it only renders what these return.
 */

import { describe, expect, test } from "bun:test";
import {
  branchState,
  createWorkspaceInput,
  issueBranchPreview,
  issueText,
  type CreateWorkspaceForm,
} from "../src/lib/create-workspace";
import type { RepoBranch, RepoIssue } from "../src/data/types";

const BRANCHES: RepoBranch[] = [
  { name: "main", sha: "a".repeat(40) },
  { name: "feat/oauth-pkce", sha: "b".repeat(40) },
];

const ISSUE: RepoIssue = {
  number: 12,
  title: "Better create workspace issue",
  author: "firesquid",
  url: "https://example.test/12",
};

const form = (patch: Partial<CreateWorkspaceForm> = {}): CreateWorkspaceForm => ({
  ship: "forge-01",
  repoName: "api-gateway",
  name: "ws-1",
  fromIssue: false,
  ephemeral: true,
  branch: "main",
  issue: null,
  ...patch,
});

describe("branchState", () => {
  test("an exact name is an existing branch", () => {
    expect(branchState("main", BRANCHES)).toEqual({ kind: "existing", branch: "main" });
    expect(branchState("feat/oauth-pkce", BRANCHES)).toEqual({ kind: "existing", branch: "feat/oauth-pkce" });
  });

  test("surrounding whitespace is trimmed before the comparison", () => {
    expect(branchState("  main  ", BRANCHES)).toEqual({ kind: "existing", branch: "main" });
  });

  test("a name differing only in case is a new branch, because git refs are case-sensitive", () => {
    expect(branchState("Main", BRANCHES)).toEqual({ kind: "new", branch: "Main" });
    expect(branchState("MAIN", BRANCHES)).toEqual({ kind: "new", branch: "MAIN" });
  });

  test("an unlisted name is a new branch", () => {
    expect(branchState("feat/new-thing", BRANCHES)).toEqual({ kind: "new", branch: "feat/new-thing" });
  });

  test("empty and whitespace-only input say nothing", () => {
    expect(branchState("", BRANCHES)).toEqual({ kind: "empty" });
    expect(branchState("   ", BRANCHES)).toEqual({ kind: "empty" });
    expect(branchState("", null)).toEqual({ kind: "empty" });
  });

  test("without a branch list the state is unknown, never a guess", () => {
    expect(branchState("main", null)).toEqual({ kind: "unknown" });
    expect(branchState("anything", null)).toEqual({ kind: "unknown" });
  });

  test("an empty branch list is knowledge: every name is new", () => {
    expect(branchState("main", [])).toEqual({ kind: "new", branch: "main" });
  });
});

describe("issueText", () => {
  test("carries the number so it can be matched as well as the title", () => {
    expect(issueText({ number: 12, title: "Better create workspace issue" })).toBe(
      "#12 Better create workspace issue",
    );
  });
});

describe("issueBranchPreview", () => {
  test("previews the name the bridge derives", () => {
    expect(issueBranchPreview({ number: 12, title: "Better create workspace issue" })).toBe(
      "12-better-create-workspace-issue",
    );
  });

  test("a number the convention cannot express previews as nothing instead of throwing", () => {
    expect(issueBranchPreview({ number: 0, title: "Impossible" })).toBeNull();
    expect(issueBranchPreview({ number: 1.5, title: "Impossible" })).toBeNull();
  });
});

describe("createWorkspaceInput", () => {
  test("branch mode sends the trimmed branch and no issueNumber key", () => {
    const input = createWorkspaceInput(form({ branch: "  feat/x  ", name: "  ws-1  " }));

    expect(input).toEqual({ ship: "forge-01", repoName: "api-gateway", name: "ws-1", branch: "feat/x" });
    expect(input && "issueNumber" in input).toBe(false);
  });

  test("issue mode sends the issue number and no branch key at all", () => {
    // Not merely a falsy branch: the bridge answers 400 to a body naming both
    // sources, and `branch: ""` names one.
    const input = createWorkspaceInput(form({ fromIssue: true, branch: "main", issue: ISSUE }));

    expect(input).toEqual({
      ship: "forge-01",
      repoName: "api-gateway",
      name: "ws-1",
      issueNumber: 12,
      ephemeral: true,
    });
    expect(input && "branch" in input).toBe(false);
  });

  test("only issue mode carries the ephemeral flag", () => {
    expect(createWorkspaceInput(form({ fromIssue: true, issue: ISSUE, ephemeral: false }))).toMatchObject({
      ephemeral: false,
    });
    const branchMode = createWorkspaceInput(form({ ephemeral: true, branch: "feat/x" }));
    expect(branchMode && "ephemeral" in branchMode).toBe(false);
  });

  test("issue mode with nothing selected is not submittable", () => {
    // Even with a perfectly good branch sitting in the other mode's field.
    expect(createWorkspaceInput(form({ fromIssue: true, branch: "main", issue: null }))).toBeNull();
  });

  test("a blank name or ship is not submittable in either mode", () => {
    expect(createWorkspaceInput(form({ name: "   " }))).toBeNull();
    expect(createWorkspaceInput(form({ ship: "" }))).toBeNull();
    expect(createWorkspaceInput(form({ fromIssue: true, issue: ISSUE, name: "" }))).toBeNull();
    expect(createWorkspaceInput(form({ fromIssue: true, issue: ISSUE, ship: "" }))).toBeNull();
  });

  test("a blank branch is not submittable in branch mode", () => {
    expect(createWorkspaceInput(form({ branch: "" }))).toBeNull();
    expect(createWorkspaceInput(form({ branch: "   " }))).toBeNull();
  });

  test("an unticked checkbox ignores a previously selected issue", () => {
    const input = createWorkspaceInput(form({ fromIssue: false, branch: "main", issue: ISSUE }));

    expect(input).toEqual({ ship: "forge-01", repoName: "api-gateway", name: "ws-1", branch: "main" });
  });
});
