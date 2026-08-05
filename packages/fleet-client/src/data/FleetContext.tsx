import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { WorkspaceRefs } from "fleet-protocol";
import type { DiffQuery } from "@/lib/diff/diff-target";
import { bridge } from "./bridge";
import type {
  ArmoryFile,
  ArmoryManifest,
  ArmoryShipState,
  Repo,
  RepoBranch,
  RepoIssue,
  Ship,
  Workspace,
  WorkspaceDetail,
} from "./types";
import { applyWorkspaceEvent } from "./workspace-events";

interface FleetValue {
  ships: Ship[];
  repos: Repo[];
  workspaces: Workspace[];
  loading: boolean;
  error: string | null;
  liveCount: number;
  activate: (repo: string, name: string) => Promise<void>;
  deactivate: (repo: string, name: string) => Promise<void>;
  /** Switch a workspace's branch, then refresh the workspace list. Rejects on failure. */
  switchBranch: (repo: string, name: string, branch: string) => Promise<void>;
  /** Delete a workspace, then refresh the workspace list. Rejects on failure. */
  deleteWorkspace: (repo: string, name: string) => Promise<void>;
  getWorkspace: (repo: string, name: string) => Promise<WorkspaceDetail>;
  getWorkspaceDiff: (repo: string, name: string, query: DiffQuery) => Promise<string>;
  getWorkspaceRefs: (repo: string, name: string) => Promise<WorkspaceRefs>;
  /**
   * Create a workspace, then refresh the workspace list. Rejects on failure.
   * Exactly one of `branch` and `issueNumber` may be given — the bridge rejects
   * both, and derives the branch itself from an issue.
   */
  createWorkspace: (input: {
    ship: string;
    repoName: string;
    name: string;
    branch?: string;
    issueNumber?: number;
  }) => Promise<void>;
  /** The branches a repo's remote advertises. Fetched on demand by the create form. */
  listRepoBranches: (name: string) => Promise<RepoBranch[]>;
  /** A repo's open issues, from its provider. Fetched on demand by the create form. */
  listRepoIssues: (name: string) => Promise<RepoIssue[]>;
  /** Register a repo, then refresh the repo list. Rejects on failure. */
  createRepo: (input: { name: string; url: string; provider?: string }) => Promise<void>;
  /** Remove a repo, then refresh the repo list. Rejects on failure. */
  deleteRepo: (name: string) => Promise<void>;
  /** Register a ship by URL, then refresh the ship list. Rejects on failure. */
  createShip: (url: string, credentials?: { shipToken?: string; bridgeToken?: string }) => Promise<void>;
  /** Deregister a ship, then refresh the ship list. Rejects on failure. */
  deleteShip: (name: string) => Promise<void>;
  getArmory: () => Promise<ArmoryManifest>;
  getArmoryFile: (path: string) => Promise<ArmoryFile>;
  listArmoryShips: () => Promise<ArmoryShipState[]>;
}

const FleetContext = createContext<FleetValue | null>(null);

/**
 * Mutations refresh the workspace list from the bridge, so all derived
 * indicators — grid dots, repo ACTIVE counts, sibling dots, the sidebar live
 * counter — update together.
 */
export function FleetProvider({ children }: { children: ReactNode }) {
  const [ships, setShips] = useState<Ship[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const [s, r, w] = await Promise.all([bridge.listShips(), bridge.listRepos(), bridge.listWorkspaces()]);
        if (cancelled) return;
        setShips(s);
        setRepos(r);
        setWorkspaces(w);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          unsubscribe = bridge.subscribeWorkspaces(
            (event) => {
              if (event.type === "sync") setStreamError(null);
              setWorkspaces((current) => applyWorkspaceEvent(current, event));
            },
            (eventError) => setStreamError(eventError.message),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    setWorkspaces(await bridge.listWorkspaces());
  }, []);

  const activate = useCallback(
    async (repo: string, name: string) => {
      try {
        await bridge.activateWorkspace(repo, name);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  const deactivate = useCallback(
    async (repo: string, name: string) => {
      try {
        await bridge.deactivateWorkspace(repo, name);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  const getWorkspace = useCallback((repo: string, name: string) => bridge.getWorkspace(repo, name), []);

  const getWorkspaceDiff = useCallback(
    (repo: string, name: string, query: DiffQuery) => bridge.getWorkspaceDiff(repo, name, query),
    [],
  );

  const getWorkspaceRefs = useCallback((repo: string, name: string) => bridge.getWorkspaceRefs(repo, name), []);

  // The armory is only ever read by its own page, so it stays out of the boot
  // snapshot: no eager state, no entry in the mount `Promise.all`.
  const getArmory = useCallback(() => bridge.getArmory(), []);
  const getArmoryFile = useCallback((path: string) => bridge.getArmoryFile(path), []);
  const listArmoryShips = useCallback(() => bridge.listArmoryShips(), []);

  // Repo/ship mutations rethrow so the calling modal can show the failure inline,
  // rather than swallowing it into the global banner like activate/deactivate.
  const refreshRepos = useCallback(async () => setRepos(await bridge.listRepos()), []);
  const refreshShips = useCallback(async () => setShips(await bridge.listShips()), []);

  const createRepo = useCallback(
    async (input: { name: string; url: string; provider?: string }) => {
      await bridge.createRepo(input);
      await refreshRepos();
    },
    [refreshRepos],
  );

  const deleteRepo = useCallback(
    async (name: string) => {
      await bridge.deleteRepo(name);
      await refreshRepos();
    },
    [refreshRepos],
  );

  const createShip = useCallback(
    async (url: string, credentials?: { shipToken?: string; bridgeToken?: string }) => {
      await bridge.createShip(url, credentials);
      await refreshShips();
    },
    [refreshShips],
  );

  const deleteShip = useCallback(
    async (name: string) => {
      await bridge.deleteShip(name);
      await refreshShips();
    },
    [refreshShips],
  );

  const createWorkspace = useCallback(
    async (input: { ship: string; repoName: string; name: string; branch?: string; issueNumber?: number }) => {
      await bridge.createWorkspace(input);
      await refresh();
    },
    [refresh],
  );

  // Branches and issues belong to the create form alone, so — like the armory —
  // they stay out of the boot snapshot and are fetched when that form opens.
  const listRepoBranches = useCallback((name: string) => bridge.listRepoBranches(name), []);
  const listRepoIssues = useCallback((name: string) => bridge.listRepoIssues(name), []);

  // Like the repo/ship mutations, these rethrow so the driving modal can show the
  // failure inline rather than swallowing it into the global banner.
  const switchBranch = useCallback(
    async (repo: string, name: string, branch: string) => {
      await bridge.switchBranch(repo, name, branch);
      await refresh();
    },
    [refresh],
  );

  const deleteWorkspace = useCallback(
    async (repo: string, name: string) => {
      await bridge.deleteWorkspace(repo, name);
      await refresh();
    },
    [refresh],
  );

  const value: FleetValue = {
    ships,
    repos,
    workspaces,
    loading,
    error: error ?? streamError,
    liveCount: workspaces.filter((w) => w.active).length,
    activate,
    deactivate,
    switchBranch,
    deleteWorkspace,
    getWorkspace,
    getWorkspaceDiff,
    getWorkspaceRefs,
    createRepo,
    deleteRepo,
    createShip,
    deleteShip,
    createWorkspace,
    listRepoBranches,
    listRepoIssues,
    getArmory,
    getArmoryFile,
    listArmoryShips,
  };

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

export function useFleet(): FleetValue {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error("useFleet must be used within a FleetProvider");
  return ctx;
}
