/**
 * helpers.ts — a stub `WorkspaceManager` for exercising the ship's API layer in
 * isolation (no tmux/git). Only the methods the routes call are implemented;
 * override any of them per test to assert error mapping and status codes.
 */

import type { WorkspaceManager } from "../src/workspace-manager";

export function stubManager(overrides: Record<string, unknown> = {}): WorkspaceManager {
  const base: Record<string, unknown> = {
    list: async () => [],
    get: async () => ({ state: "inactive", repoName: "r", name: "n", branch: "main" }),
    create: async (b: { url: string; repoName: string; name: string; branch: string }) => ({
      repoName: b.repoName,
      name: b.name,
      branch: b.branch,
      active: false,
    }),
    switchBranch: async () => {},
    activate: async () => {},
    deactivate: async () => {},
    remove: async () => {},
    sessionName: (repoName: string, name: string) => `${repoName}__${name}`,
    subscribe: () => () => {},
    snapshotEvent: async () => ({ type: "sync", ship: "stub", at: "t", workspaces: [] }),
    ...overrides,
  };
  return base as unknown as WorkspaceManager;
}

/** A minimal FleetShipConfig for `createApp`. */
export const stubConfig = { fleetDirectory: "/tmp/stub-fleet", port: 4700, name: "stub-ship" };
