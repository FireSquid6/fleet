import { describe, expect, test } from "bun:test";
import type { EphemeralWorkspace } from "fleet-protocol";
import { ephemeralSummary } from "@/components/Ephemeral";

const watching: EphemeralWorkspace = {
  issueNumber: 37,
  branch: "37-add-ephemeral-workspaces",
  cleanup: "watching",
  blockedReason: null,
  blockedAt: null,
  pullRequest: null,
};

describe("ephemeralSummary", () => {
  test("says when no pull request has been opened yet", () => {
    expect(ephemeralSummary(watching)).toBe("issue #37 · no pull request yet");
  });

  test("names the pull request the last sweep saw", () => {
    expect(
      ephemeralSummary({
        ...watching,
        pullRequest: { number: 41, state: "open", url: "https://example.test/41" },
      }),
    ).toBe("issue #37 · PR #41 open");
  });

  test("carries the refusal when cleanup is blocked", () => {
    expect(
      ephemeralSummary({
        ...watching,
        cleanup: "blocked",
        blockedReason: "2 commits not on any remote",
        blockedAt: "2026-08-03T00:00:00.000Z",
        pullRequest: { number: 41, state: "closed", url: "https://example.test/41" },
      }),
    ).toBe("issue #37 · PR #41 closed · cleanup blocked: 2 commits not on any remote");
  });

  test("does not pretend to know a reason it was not given", () => {
    expect(ephemeralSummary({ ...watching, cleanup: "blocked" })).toBe(
      "issue #37 · no pull request yet · cleanup blocked: reason unknown",
    );
  });
});
