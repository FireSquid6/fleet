/**
 * fuzzy.test.ts — the subsequence matcher behind the branch and issue pickers.
 *
 * Scores are never asserted absolutely, only as orderings: the constants are an
 * implementation detail, but "a prefix beats a scattered match" is the contract
 * the pickers are built on. Each ordering case is built so that the property it
 * names is the only thing that can decide it — same haystack length, same
 * contiguity, same separators — because a case several rules could settle pins
 * none of them. Ranges, which drive the highlighting, are asserted exactly.
 */

import { describe, expect, test } from "bun:test";
import { fuzzySearch } from "../src/lib/fuzzy";

const ranked = (items: string[], query: string): string[] =>
  fuzzySearch(items, query, (item) => item).map((match) => match.item);

const rangesOf = (text: string, query: string): [number, number][] | undefined =>
  fuzzySearch([text], query, (item) => item)[0]?.ranges;

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
    expect(rangesOf("Release/2.3", "r2")).toEqual([
      [0, 1],
      [8, 9],
    ]);
  });

  test("ranges are half-open indices into the original text, adjacent ones merged", () => {
    expect(rangesOf("rate-limit", "rali")).toEqual([
      [0, 2],
      [5, 7],
    ]);
  });

  test("a fully contiguous match is one range covering the query", () => {
    expect(rangesOf("feat/oauth-pkce", "feat")).toEqual([[0, 4]]);
  });

  test("a match at the start outranks the same match in the middle", () => {
    expect(ranked(["domain", "main"], "main")).toEqual(["main", "domain"]);
  });

  test("starting at index 0 beats starting after a separator, all else equal", () => {
    // Same length, same four-character contiguous run: only the start bonus —
    // which has to outweigh the separator bonus it gives up — can order these.
    expect(ranked(["xx-main-xx", "main-xxxxx"], "main")).toEqual(["main-xxxxx", "xx-main-xx"]);
  });

  test("a contiguous match outranks a gappy one", () => {
    expect(ranked(["f-e-a-t", "feat"], "feat")).toEqual(["feat", "f-e-a-t"]);
  });

  test("a match after a separator outranks a closer one mid-word", () => {
    expect(ranked(["firebrand", "fix-rate"], "fr")).toEqual(["fix-rate", "firebrand"]);
  });

  test("the closer of two equally gappy matches wins", () => {
    // Identical length, identical start, neither contiguous, no separators: the
    // distance between the two matched characters is all that differs.
    expect(ranked(["axxxxbxxxx", "axbxxxxxxx"], "ab")).toEqual(["axbxxxxxxx", "axxxxbxxxx"]);
  });

  test("distance stops counting once it is simply far", () => {
    // Gaps of 12 and 20 are both past the cap, so these tie and keep input order.
    const far = `a${"x".repeat(12)}b${"x".repeat(10)}`;
    const farther = `a${"x".repeat(20)}b${"x".repeat(2)}`;

    expect(ranked([far, farther], "ab")).toEqual([far, farther]);
    expect(ranked([farther, far], "ab")).toEqual([farther, far]);
  });

  test("the shorter of two equally good matches wins", () => {
    expect(ranked(["main-branch", "main"], "main")).toEqual(["main", "main-branch"]);
  });

  test("ties keep the input order", () => {
    expect(ranked(["alpha-one", "alpha-two"], "alpha")).toEqual(["alpha-one", "alpha-two"]);
    expect(ranked(["alpha-two", "alpha-one"], "alpha")).toEqual(["alpha-two", "alpha-one"]);
  });

  test("the whole word wins even when an earlier character could start the match", () => {
    // Scanning purely left to right consumes the `m` of "re*m*ove" and ranks the
    // branch that really contains "main" below one that merely has the letters.
    expect(ranked(["renovate/lock-file-maintenance", "chore/remove-main-shim"], "main")).toEqual([
      "chore/remove-main-shim",
      "renovate/lock-file-maintenance",
    ]);
    expect(rangesOf("chore/remove-main-shim", "main")).toEqual([[13, 17]]);
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

  test("an astral character is one whole range, and still counts as contiguous", () => {
    expect(rangesOf("Fix 🐛 crash", "🐛")).toEqual([[4, 6]]);
    expect(rangesOf("Fix 🐛 crash", "🐛 c")).toEqual([[4, 8]]);
  });

  test("text whose case folding changes length still ranks, but highlights nothing", () => {
    // U+0130 lowercases to two code units, so every index past it addresses the
    // wrong character; no highlight beats the wrong one.
    expect(ranked(["fix İO errors"], "errors")).toEqual(["fix İO errors"]);
    expect(rangesOf("fix İO errors", "errors")).toEqual([]);
    expect(rangesOf("İİİ abc", "abc")).toEqual([]);
  });
});
