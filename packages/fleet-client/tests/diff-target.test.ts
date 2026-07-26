import { describe, expect, test } from "bun:test";
import {
  clampCommitCount,
  DEFAULT_COMMIT_COUNT,
  describeDiffTarget,
  diffQuery,
  MAX_COMMIT_COUNT,
} from "../src/lib/diff/diff-target";

describe("diffQuery", () => {
  test("working tree diffs against HEAD and includes untracked files", () => {
    expect(diffQuery({ kind: "working" })).toEqual({ range: "HEAD", includeUntracked: true });
  });

  test("branch comparison uses the merge base only when uncommitted work is wanted", () => {
    expect(diffQuery({ kind: "branch", base: "main", includeWorking: true })).toEqual({
      range: "main",
      mergeBase: true,
      includeUntracked: true,
    });
    expect(diffQuery({ kind: "branch", base: "main", includeWorking: false })).toEqual({
      range: "main...HEAD",
    });
  });

  test("last-N-commits diffs from an ancestor so uncommitted work rides along", () => {
    expect(diffQuery({ kind: "commits", count: 3 })).toEqual({ range: "HEAD~3", includeUntracked: true });
  });

  test("out-of-range commit counts are clamped before they reach git", () => {
    expect(diffQuery({ kind: "commits", count: 0 })).toEqual({ range: "HEAD~1", includeUntracked: true });
    expect(diffQuery({ kind: "commits", count: 999 })).toEqual({
      range: `HEAD~${MAX_COMMIT_COUNT}`,
      includeUntracked: true,
    });
  });
});

describe("clampCommitCount", () => {
  test("keeps counts within [1, MAX] and falls back for non-numbers", () => {
    expect(clampCommitCount(5)).toBe(5);
    expect(clampCommitCount(-2)).toBe(1);
    expect(clampCommitCount(MAX_COMMIT_COUNT + 10)).toBe(MAX_COMMIT_COUNT);
    expect(clampCommitCount(2.7)).toBe(2);
    expect(clampCommitCount(Number.NaN)).toBe(DEFAULT_COMMIT_COUNT);
  });
});

describe("describeDiffTarget", () => {
  test("describes each target, pluralizing the commit count", () => {
    expect(describeDiffTarget({ kind: "working" })).toBe("uncommitted changes");
    expect(describeDiffTarget({ kind: "branch", base: "main", includeWorking: true })).toBe(
      "this branch vs main, including uncommitted work",
    );
    expect(describeDiffTarget({ kind: "branch", base: "main", includeWorking: false })).toBe(
      "commits on this branch since main",
    );
    expect(describeDiffTarget({ kind: "commits", count: 1 })).toBe("last 1 commit plus uncommitted work");
    expect(describeDiffTarget({ kind: "commits", count: 4 })).toBe("last 4 commits plus uncommitted work");
  });
});
