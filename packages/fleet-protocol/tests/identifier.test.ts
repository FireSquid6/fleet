import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateRepoInputSchema,
  CreateWorkspaceRequestSchema,
  FleetEventSchema,
  FleetIdentifierSchema,
  RepoSchema,
  ShipSchema,
  WorkspaceSummarySchema,
  WorkspaceStatusSchema,
  parseFleetIdentifier,
} from "..";

describe("FleetIdentifierSchema", () => {
  test("accepts values up to 128 UTF-8 bytes without changing them", () => {
    expect(parseFleetIdentifier("  repo  ")).toBe("  repo  ");
    expect(FleetIdentifierSchema.parse("a".repeat(128))).toHaveLength(128);
    expect(FleetIdentifierSchema.parse("é".repeat(64))).toBe("é".repeat(64));
  });

  test("rejects values over 128 UTF-8 bytes", () => {
    expect(FleetIdentifierSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(FleetIdentifierSchema.safeParse(`${"é".repeat(64)}a`).success).toBe(false);
  });

  test.each(["", ".", "..", "a/b", "a\\b", "line\nfeed", "nul\0byte", `next\u0085line`])(
    "rejects %p",
    (value) => expect(FleetIdentifierSchema.safeParse(value).success).toBe(false),
  );

  test("rejects lone surrogates that alias U+FFFD at the filesystem boundary", async () => {
    const surrogate = "\uD800";
    const replacement = "\uFFFD";
    expect(new TextEncoder().encode(surrogate)).toEqual(new TextEncoder().encode(replacement));
    expect(FleetIdentifierSchema.safeParse(surrogate).success).toBe(false);
    expect(FleetIdentifierSchema.safeParse(replacement).success).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "fleet-identifier-"));
    try {
      await mkdir(join(root, replacement));
      expect((await stat(join(root, surrogate))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is reused by workspace, event, and repo schemas", () => {
    const summary = { repoName: "../repo", name: "ws", branch: "main", active: false };
    expect(WorkspaceSummarySchema.safeParse(summary).success).toBe(false);
    expect(
      FleetEventSchema.safeParse({ type: "workspace.created", ship: "ship", at: "now", workspace: summary }).success,
    ).toBe(false);
    expect(
      FleetEventSchema.safeParse({ type: "sync", ship: "bad/ship", at: "now", workspaces: [] }).success,
    ).toBe(false);
    expect(RepoSchema.safeParse({ name: "bad/name", url: "url", provider: "custom" }).success).toBe(false);
    expect(CreateRepoInputSchema.safeParse({ name: "..", url: "url" }).success).toBe(false);
    expect(ShipSchema.safeParse({ name: "bad/ship", url: "url" }).success).toBe(false);
    expect(
      CreateWorkspaceRequestSchema.safeParse({ url: "url", repoName: "repo", name: "bad/name", branch: "main" })
        .success,
    ).toBe(false);
    expect(
      WorkspaceStatusSchema.safeParse({ state: "inactive", repoName: "../repo", name: "ws", branch: "main" })
        .success,
    ).toBe(false);
  });
});
