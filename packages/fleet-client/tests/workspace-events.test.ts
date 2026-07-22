import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "fleet-protocol";
import { applyWorkspaceEvent } from "../src/data/workspace-events";
import type { Workspace } from "../src/data/types";

const status: AgentStatus = {
  state: "building",
  description: "Implementing status updates",
  model: "sonnet",
  provider: "anthropic",
  harness: "opencode",
};

const workspace = (name: string, agent: AgentStatus | null = null): Workspace => ({
  repoName: "repo",
  name,
  branch: "main",
  active: agent !== null,
  agent,
  ship: "ship-a",
});

describe("applyWorkspaceEvent", () => {
  test("replaces all rows on sync", () => {
    expect(applyWorkspaceEvent([workspace("old")], {
      type: "sync",
      at: "t",
      workspaces: [workspace("current", status)],
    })).toEqual([workspace("current", status)]);
  });

  test("upserts status and clears it on deactivation", () => {
    const updated = applyWorkspaceEvent([workspace("one")], {
      type: "workspace.agent_status_changed",
      at: "t",
      workspace: workspace("one", status),
    });
    expect(updated[0]?.agent).toEqual(status);

    const cleared = applyWorkspaceEvent(updated, {
      type: "workspace.deactivated",
      at: "t",
      workspace: workspace("one"),
    });
    expect(cleared[0]?.agent).toBeNull();
  });

  test("removes a workspace by repo and name", () => {
    expect(applyWorkspaceEvent([workspace("one"), workspace("two")], {
      type: "workspace.removed",
      at: "t",
      workspace: workspace("one"),
    }).map((item) => item.name)).toEqual(["two"]);
  });
});
