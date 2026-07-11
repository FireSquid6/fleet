/**
 * helpers.ts — a stub `WorkspaceManager` for exercising the ship's API layer in
 * isolation (no tmux/git). Only the methods the routes call are implemented;
 * override any of them per test to assert error mapping and status codes.
 */

import type { WorkspaceManager } from "../src/workspace-manager";

export function stubManager(overrides: Record<string, unknown> = {}): WorkspaceManager {
  const base: Record<string, unknown> = {
    list: async () => [],
    listRepos: async () => [],
    get: async () => ({ state: "inactive", repo: "r", name: "n", branch: "main" }),
    create: async (b: { repo: string; name: string; branch: string }) => ({ ...b, active: false }),
    switchBranch: async () => {},
    activate: async () => {},
    deactivate: async () => {},
    remove: async () => {},
    sessionName: (repo: string, name: string) => `${repo}__${name}`,
    subscribe: () => () => {},
    snapshotEvent: async () => ({ type: "sync", ship: "stub", at: "t", workspaces: [] }),
    ...overrides,
  };
  return base as unknown as WorkspaceManager;
}

/** A minimal FleetShipConfig for `createApp`. */
export const stubConfig = { fleetDirectory: "/tmp/stub-fleet", port: 4700, name: "stub-ship" };
