/**
 * AuthContext — session state for the web UI.
 *
 * On mount it reads `/auth/config` to learn whether the bridge enforces auth,
 * and if so resolves the current session via `/auth/whoami`. `RequireAuth` gates
 * the app behind a login redirect. When the bridge runs open (`authRequired:
 * false`) the UI behaves as it did before auth existed.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import * as authApi from "./auth";
import type { AuthUser } from "./auth";

interface AuthValue {
  authRequired: boolean;
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authRequired, setAuthRequired] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The mock backend has no bridge to ask, so run the UI open (as it did
    // before auth existed).
    if (typeof process !== "undefined" && process.env.BUN_PUBLIC_USE_MOCK === "true") {
      setLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const config = await authApi.getAuthConfig();
        if (cancelled) return;
        setAuthRequired(config.authRequired);
        if (config.authRequired) {
          const me = await authApi.whoami();
          if (!cancelled) setUser(me);
        }
      } catch {
        // Can't reach /auth/config → fail closed: require a login.
        if (!cancelled) setAuthRequired(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setUser(await authApi.login(username, password));
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ authRequired, user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

/** Redirect to `/login` when auth is enforced and there's no session. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { authRequired, user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null; // brief; avoids a login flash before whoami resolves
  if (authRequired && !user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}
