/**
 * helpers.ts — a stub `WorkspaceManager` for exercising the ship's API layer in
 * isolation (no tmux/git). Only the methods the routes call are implemented;
 * override any of them per test to assert error mapping and status codes.
 */

import type { WorkspaceManager } from "../src/workspace-manager";
import { workspaceSessionName } from "../src/workspace-session";

export function stubManager(overrides: Record<string, unknown> = {}): WorkspaceManager {
  const base: Record<string, unknown> = {
    list: async () => [],
    get: async () => ({ state: "inactive", repoName: "r", name: "n", branch: "main" }),
    diff: async () => "DIFF",
    create: async (b: { url: string; repoName: string; name: string; branch: string }) => ({
      repoName: b.repoName,
      name: b.name,
      branch: b.branch,
      active: false,
    }),
    switchBranch: async () => {},
    initAgent: async (_r: string, _n: string, b: { model: string; provider: string; harness: string }) => ({
      state: "idle",
      description: "Created session at t",
      model: b.model,
      provider: b.provider,
      harness: b.harness,
    }),
    agentStatus: () => null,
    updateAgentStatus: async (_r: string, _n: string, u: { state: string; description: string }) => ({
      state: u.state,
      description: u.description,
      model: "opus",
      provider: "anthropic",
      harness: "cc",
    }),
    activate: async () => {},
    deactivate: async () => {},
    remove: async () => {},
    sessionName: workspaceSessionName,
    subscribe: () => () => {},
    snapshotEvent: async () => ({ type: "sync", ship: "stub", at: "t", workspaces: [] }),
    ...overrides,
  };
  return base as unknown as WorkspaceManager;
}

/** A minimal FleetShipConfig for `createApp`. */
export const stubConfig = { fleetDirectory: "/tmp/stub-fleet", port: 4700, name: "stub-ship" };
