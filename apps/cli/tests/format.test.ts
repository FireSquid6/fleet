import { describe, expect, test } from "bun:test";
import { formatWorkspaceTable } from "../src/format";

describe("formatWorkspaceTable", () => {
  test("renders headers only for an empty list", () => {
    const out = formatWorkspaceTable([]);
    expect(out).toBe("REPO  NAME  BRANCH  ACTIVE");
  });

  test("aligns columns to the widest cell", () => {
    const out = formatWorkspaceTable([
      { repoName: "Hello-World", name: "ws1", branch: "master", active: true },
      { repoName: "x", name: "y", branch: "main", active: false },
    ]);

    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("REPO         NAME  BRANCH  ACTIVE");
    expect(lines[1]).toBe("Hello-World  ws1   master  yes");
    expect(lines[2]).toBe("x            y     main    no");
  });
});
