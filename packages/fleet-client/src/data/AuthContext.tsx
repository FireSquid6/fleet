import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "fleet-protocol";
import { fetchAuthMode, fetchMe, login, logout } from "./auth";
import { useMock } from "./bridge";
import { clearToken, getToken, onUnauthorized } from "./token";

interface AuthValue {
  resolved: boolean;
  authRequired: boolean;
  user: User | null;
  error: string | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Kept out of `FleetContext`: the token has to be settled before the first
 * request that carries it goes out.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [resolved, setResolved] = useState(false);
  const [authRequired, setAuthRequired] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onUnauthorized(() => setUser(null));
    return () => onUnauthorized(null);
  }, []);

  useEffect(() => {
    if (useMock) {
      setAuthRequired(false);
      setResolved(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const required = await fetchAuthMode();
        const me = required && getToken() ? await fetchMe() : null;
        if (cancelled) return;
        if (required && !me) clearToken();
        setAuthRequired(required);
        setUser(me);
      } catch (e) {
        if (cancelled) return;
        // Fail closed: `authRequired` is left at its initial `true`, so a bridge
        // that cannot answer /auth/mode does not wave the app through.
        setError((e as Error).message);
      } finally {
        if (!cancelled) setResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    setUser(await login(username, password));
    setError(null);
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
  }, []);

  const value: AuthValue = { resolved, authRequired, user, error, signIn, signOut };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
