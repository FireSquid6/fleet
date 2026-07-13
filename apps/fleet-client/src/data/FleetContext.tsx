import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { bridge } from "./bridge";
import type { Repo, Ship, Workspace, WorkspaceDetail } from "./types";

interface FleetValue {
  ships: Ship[];
  repos: Repo[];
  workspaces: Workspace[];
  loading: boolean;
  /** Set when talking to the bridge fails (e.g. it is unreachable). */
  error: string | null;
  /** Number of active workspaces across the fleet (drives "N sessions live"). */
  liveCount: number;
  activate: (repo: string, name: string) => Promise<void>;
  deactivate: (repo: string, name: string) => Promise<void>;
  getWorkspace: (repo: string, name: string) => Promise<WorkspaceDetail>;
}

const FleetContext = createContext<FleetValue | null>(null);

/**
 * Loads the fleet snapshot once and shares it with every view. Mutations refresh
 * the workspace list from the bridge, so all derived indicators — grid dots,
 * repo ACTIVE counts, sibling dots, the sidebar live counter — update together.
 */
export function FleetProvider({ children }: { children: ReactNode }) {
  const [ships, setShips] = useState<Ship[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
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

  const value: FleetValue = {
    ships,
    repos,
    workspaces,
    loading,
    error,
    liveCount: workspaces.filter((w) => w.active).length,
    activate,
    deactivate,
    getWorkspace,
  };

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

export function useFleet(): FleetValue {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error("useFleet must be used within a FleetProvider");
  return ctx;
}
