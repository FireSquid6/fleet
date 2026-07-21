import { describe, expect, test } from "bun:test";
import { workspaceSessionName } from "../src/workspace-session";

describe("workspaceSessionName", () => {
  test("matches the version 1 length-prefixed SHA-256 fixture", () => {
    expect(workspaceSessionName("hello-world", "feature")).toBe(
      "ws-15a859b0afebf17d845532a409102e8ec88b090ac93ab0d42ba1f25702d02f01",
    );
  });

  test("always emits a fixed safe target", () => {
    for (const [repo, workspace] of [
      ["repo", "workspace"],
      ["répo", "工作区"],
      ["a".repeat(128), "é".repeat(64)],
    ] as const) {
      expect(workspaceSessionName(repo, workspace)).toMatch(/^ws-[0-9a-f]{64}$/);
      expect(workspaceSessionName(repo, workspace)).toHaveLength(67);
    }
  });

  test("does not collapse punctuation", () => {
    expect(workspaceSessionName("a.b", "c")).not.toBe(workspaceSessionName("a-b", "c"));
  });

  test("does not collapse identifier boundaries", () => {
    expect(workspaceSessionName("a__b", "c")).not.toBe(workspaceSessionName("a", "b__c"));
  });

  test("hashes UTF-8 bytes deterministically", () => {
    expect(workspaceSessionName("répo", "工作区")).toBe(
      "ws-7f167c7a24a46bf88314a55f64d78f1e7ee0b67338ff32885b8f8aa48293ff34",
    );
  });
});
