/**
 * create-workspace.test.ts — the decisions the create-workspace form makes about
 * the branch the user typed. There is no DOM harness in this package, so this is
 * where the form's logic is held to account; the component around it only renders
 * what these return.
 */

import { describe, expect, test } from "bun:test";
import { branchState, issueBranchPreview, issueText } from "../src/lib/create-workspace";
import type { RepoBranch } from "../src/data/types";

const BRANCHES: RepoBranch[] = [
  { name: "main", sha: "a".repeat(40) },
  { name: "feat/oauth-pkce", sha: "b".repeat(40) },
];

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
