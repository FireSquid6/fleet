/**
 * fuzzy.test.ts — the subsequence matcher behind the branch and issue pickers.
 *
 * Scores are never asserted absolutely, only as orderings: the constants are an
 * implementation detail, but "a prefix beats a scattered match" is the contract
 * the pickers are built on. Ranges, which drive the highlighting, are asserted
 * exactly.
 */

import { describe, expect, test } from "bun:test";
import { fuzzySearch, splitRanges } from "../src/lib/fuzzy";

const ranked = (items: string[], query: string): string[] =>
  fuzzySearch(items, query, (item) => item).map((match) => match.item);

describe("fuzzySearch", () => {
  test("an empty query returns every item, in order, unmatched", () => {
    const items = ["main", "develop", "feat/oauth-pkce"];

    const matches = fuzzySearch(items, "", (item) => item);

    expect(matches.map((m) => m.item)).toEqual(items);
    expect(matches.every((m) => m.ranges.length === 0)).toBe(true);
    expect(matches.every((m) => m.score === 0)).toBe(true);
  });

  test("a query no item contains as a subsequence returns nothing", () => {
    expect(ranked(["main", "develop"], "zzz")).toEqual([]);
    // Right characters, wrong order — a subsequence is ordered.
    expect(ranked(["main"], "nima")).toEqual([]);
  });

  test("matches a scattered subsequence, not just a substring", () => {
    expect(ranked(["feat/oauth-pkce", "main"], "fpk")).toEqual(["feat/oauth-pkce"]);
  });

  test("matching is case-insensitive in both directions", () => {
    expect(ranked(["main"], "MAIN")).toEqual(["main"]);
    expect(ranked(["MAIN"], "main")).toEqual(["MAIN"]);
    expect(fuzzySearch(["Release/2.3"], "r2", (i) => i)[0]?.ranges).toEqual([
      [0, 1],
      [8, 9],
    ]);
  });

  test("ranges are half-open indices into the original text, adjacent ones merged", () => {
    const [match] = fuzzySearch(["rate-limit"], "rali", (item) => item);

    expect(match?.ranges).toEqual([
      [0, 2],
      [5, 7],
    ]);
  });

  test("a fully contiguous match is one range covering the query", () => {
    const [match] = fuzzySearch(["feat/oauth-pkce"], "feat", (item) => item);

    expect(match?.ranges).toEqual([[0, 4]]);
  });

  test("a match at the start outranks the same match in the middle", () => {
    expect(ranked(["domain", "main"], "main")).toEqual(["main", "domain"]);
  });

  test("a contiguous match outranks a gappy one", () => {
    expect(ranked(["f-e-a-t", "feat"], "feat")).toEqual(["feat", "f-e-a-t"]);
  });

  test("a match after a separator outranks a closer one mid-word", () => {
    expect(ranked(["firebrand", "fix-rate"], "fr")).toEqual(["fix-rate", "firebrand"]);
  });

  test("the shorter of two equally good matches wins", () => {
    expect(ranked(["main-branch", "main"], "main")).toEqual(["main", "main-branch"]);
  });

  test("ties keep the input order", () => {
    expect(ranked(["alpha-one", "alpha-two"], "alpha")).toEqual(["alpha-one", "alpha-two"]);
    expect(ranked(["alpha-two", "alpha-one"], "alpha")).toEqual(["alpha-two", "alpha-one"]);
  });

  test("matches over the projected text, not the item itself", () => {
    const issues = [
      { number: 12, title: "Better create workspace issue" },
      { number: 47, title: "Rate limiter drops requests" },
    ];
    const text = (issue: { number: number; title: string }) => `#${issue.number} ${issue.title}`;

    expect(fuzzySearch(issues, "12", text).map((m) => m.item.number)).toEqual([12]);
    expect(fuzzySearch(issues, "workspace", text).map((m) => m.item.number)).toEqual([12]);
  });
});

describe("splitRanges", () => {
  test("sends each range to its side and rebases the right one", () => {
    expect(
      splitRanges(
        [
          [0, 2],
          [5, 7],
        ],
        3,
      ),
    ).toEqual([[[0, 2]], [[2, 4]]]);
  });

  test("a range straddling the cut appears on both sides", () => {
    expect(splitRanges([[1, 5]], 3)).toEqual([[[1, 3]], [[0, 2]]]);
  });

  test("a cut past the end or at zero leaves one side empty", () => {
    expect(splitRanges([[1, 3]], 10)).toEqual([[[1, 3]], []]);
    expect(splitRanges([[1, 3]], 0)).toEqual([[], [[1, 3]]]);
  });
});
