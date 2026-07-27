import { describe, expect, test } from "bun:test";
import { FleetIdentifierSchema, issueBranchName } from "..";

describe("issueBranchName", () => {
  test("joins the number with a slug of the title", () => {
    expect(issueBranchName({ number: 12, title: "Better create workspace issue" })).toBe(
      "12-better-create-workspace-issue",
    );
  });

  test("collapses punctuation, emoji and non-Latin runs into single dashes", () => {
    expect(issueBranchName({ number: 3, title: "Fix: the __thing__ (again)!" })).toBe(
      "3-fix-the-thing-again",
    );
    expect(issueBranchName({ number: 4, title: "🔥 hot 🔥 path 🔥" })).toBe("4-hot-path");
    expect(issueBranchName({ number: 5, title: "café / naïve" })).toBe("5-caf-na-ve");
  });

  test("falls back to the bare number when the title has no Latin alphanumerics", () => {
    expect(issueBranchName({ number: 7, title: "" })).toBe("7");
    expect(issueBranchName({ number: 8, title: "!!! ??? ---" })).toBe("8");
    expect(issueBranchName({ number: 9, title: "日本語のタイトル" })).toBe("9");
  });

  test("caps the total length at 60 characters and never ends on a dash", () => {
    const long = issueBranchName({
      number: 123,
      title: "a very long issue title that keeps going and going and going well past the cap",
    });
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe("123-a-very-long-issue-title-that-keeps-going-and-going-and-g");
    expect(long.endsWith("-")).toBe(false);
  });

  test("strips the separator when the cap lands right after one", () => {
    // The 60th character is the dash before "cut", so the dash goes with the tail.
    const name = issueBranchName({ number: 1, title: `${"a".repeat(57)} cut here` });
    expect(name).toBe(`1-${"a".repeat(57)}`);
  });

  test("output is a valid fleet identifier", () => {
    for (const title of ["Better create workspace issue", "", "🔥".repeat(40), "x".repeat(500)]) {
      const name = issueBranchName({ number: 42, title });
      expect(FleetIdentifierSchema.safeParse(name).success).toBe(true);
      expect(name).toMatch(/^[0-9][a-z0-9-]*$/);
    }
  });

  test("rejects a number that is not a positive integer", () => {
    for (const number of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => issueBranchName({ number, title: "t" })).toThrow();
    }
  });
});
