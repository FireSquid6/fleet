import { describe, expect, test } from "bun:test";
import type { ArmorySyncState } from "fleet-protocol";
import {
  abbreviateRevision,
  armoryShipState,
  formatArmoryShipTable,
  formatArmoryTable,
  formatTimestamp,
  formatFleetWorkspaceTable,
  formatRepoTable,
  formatShipTable,
  formatWorkspaceTable,
} from "../src/format";

describe("formatWorkspaceTable", () => {
  test("renders headers only for an empty list", () => {
    const out = formatWorkspaceTable([]);
    expect(out).toBe("REPO  NAME  BRANCH  ACTIVE");
  });

  test("aligns columns to the widest cell", () => {
    const out = formatWorkspaceTable([
      { repoName: "Hello-World", name: "ws1", branch: "master", active: true, agent: null },
      { repoName: "x", name: "y", branch: "main", active: false, agent: null },
    ]);

    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("REPO         NAME  BRANCH  ACTIVE");
    expect(lines[1]).toBe("Hello-World  ws1   master  yes");
    expect(lines[2]).toBe("x            y     main    no");
  });
});

describe("formatFleetWorkspaceTable", () => {
  test("renders headers only for an empty list", () => {
    expect(formatFleetWorkspaceTable([])).toBe("SHIP  REPO  NAME  BRANCH  ACTIVE");
  });

  test("includes the owning ship and aligns columns", () => {
    const out = formatFleetWorkspaceTable([
      { ship: "orca", repoName: "Hello-World", name: "ws1", branch: "master", active: true, agent: null },
      { ship: "a", repoName: "x", name: "y", branch: "main", active: false, agent: null },
    ]);

    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("SHIP  REPO         NAME  BRANCH  ACTIVE");
    expect(lines[1]).toBe("orca  Hello-World  ws1   master  yes");
    expect(lines[2]).toBe("a     x            y     main    no");
  });
});

describe("formatShipTable", () => {
  test("renders headers only for an empty list", () => {
    expect(formatShipTable([])).toBe("NAME  URL  STATUS");
  });

  test("aligns columns to the widest cell", () => {
    const out = formatShipTable([
      { name: "orca", url: "http://localhost:4700", status: "online" },
      { name: "a", url: "http://x:1", status: "offline" },
    ]);

    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME  URL                    STATUS");
    expect(lines[1]).toBe("orca  http://localhost:4700  online");
    expect(lines[2]).toBe("a     http://x:1             offline");
  });
});

describe("formatRepoTable", () => {
  test("renders headers only for an empty list", () => {
    expect(formatRepoTable([])).toBe("NAME  URL  PROVIDER");
  });

  test("aligns columns to the widest cell", () => {
    const out = formatRepoTable([
      { name: "Hello-World", url: "git@github.com:x/y.git", provider: "github" },
      { name: "x", url: "u", provider: "custom" },
    ]);

    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME         URL                     PROVIDER");
    expect(lines[1]).toBe("Hello-World  git@github.com:x/y.git  github");
    expect(lines[2]).toBe("x            u                       custom");
  });
});

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

function syncState(overrides: Partial<ArmorySyncState> = {}): ArmorySyncState {
  return {
    revision: REVISION_A,
    bridgeUrl: "http://bridge:4800",
    syncedAt: "2026-07-26T10:00:00.000Z",
    fileCount: 3,
    install: null,
    lastError: null,
    ...overrides,
  };
}

describe("abbreviateRevision", () => {
  test("takes the first 12 characters", () => {
    expect(abbreviateRevision(REVISION_A)).toBe("aaaaaaaaaaaa");
  });

  test("renders a missing revision as a placeholder", () => {
    expect(abbreviateRevision(null)).toBe("-");
  });
});

describe("formatTimestamp", () => {
  test("renders an ISO string unchanged", () => {
    expect(formatTimestamp("2026-07-26T10:00:00.000Z")).toBe("2026-07-26T10:00:00.000Z");
  });

  test("normalizes the Date that Eden revives a timestamp into", () => {
    expect(formatTimestamp(new Date("2026-07-26T10:00:00.000Z"))).toBe("2026-07-26T10:00:00.000Z");
  });

  test("renders a missing timestamp as a placeholder", () => {
    expect(formatTimestamp(null)).toBe("-");
  });

  test("passes an unparseable value through rather than printing Invalid Date", () => {
    expect(formatTimestamp("not a date")).toBe("not a date");
  });
});

describe("armoryShipState", () => {
  test("is unknown when the bridge could not reach the ship", () => {
    expect(armoryShipState(REVISION_A, null)).toBe("unknown");
  });

  test("is never when the ship has not applied a revision", () => {
    expect(armoryShipState(REVISION_A, syncState({ revision: null }))).toBe("never");
  });

  test("compares the applied revision against the bridge's", () => {
    expect(armoryShipState(REVISION_A, syncState())).toBe("in sync");
    expect(armoryShipState(REVISION_B, syncState())).toBe("behind");
  });

  test("error outranks both the revision comparison and a null revision", () => {
    expect(armoryShipState(REVISION_A, syncState({ lastError: "pull failed" }))).toBe("error");
    expect(armoryShipState(REVISION_B, syncState({ lastError: "pull failed" }))).toBe("error");
    expect(armoryShipState(REVISION_A, syncState({ revision: null, lastError: "pull failed" }))).toBe(
      "error",
    );
  });
});

describe("formatArmoryTable", () => {
  test("renders headers only for an empty list", () => {
    expect(formatArmoryTable([])).toBe("SECTION  PATH  SIZE  MODE");
  });

  test("keeps the section prefix on PATH and renders the mode in octal", () => {
    const out = formatArmoryTable([
      {
        path: "dotfiles/gitconfig",
        section: "dotfiles",
        size: 42,
        sha256: "0".repeat(64),
        mode: 0o644,
      },
      {
        path: "skills/reviewer/SKILL.md",
        section: "skills",
        size: 1024,
        sha256: "1".repeat(64),
        mode: 0o755,
      },
    ]);

    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("SECTION   PATH                      SIZE  MODE");
    expect(lines[1]).toBe("dotfiles  dotfiles/gitconfig        42    0644");
    expect(lines[2]).toBe("skills    skills/reviewer/SKILL.md  1024  0755");
  });
});

describe("formatArmoryShipTable", () => {
  test("renders headers only for an empty list", () => {
    expect(formatArmoryShipTable(REVISION_A, [])).toBe("SHIP  STATUS  REVISION  SYNCED  STATE");
  });

  test("derives STATE per ship and blanks an unreachable ship's columns", () => {
    const out = formatArmoryShipTable(REVISION_A, [
      { ship: "orca", status: "online", state: syncState() },
      { ship: "krill", status: "online", state: syncState({ revision: REVISION_B }) },
      { ship: "a", status: "offline", state: null },
    ]);

    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("SHIP   STATUS   REVISION      SYNCED                    STATE");
    expect(lines[1]).toBe("orca   online   aaaaaaaaaaaa  2026-07-26T10:00:00.000Z  in sync");
    expect(lines[2]).toBe("krill  online   bbbbbbbbbbbb  2026-07-26T10:00:00.000Z  behind");
    expect(lines[3]).toBe("a      offline  -             -                         unknown");
  });
});
