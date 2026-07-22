import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/data/AuthContext";

/** Username/password sign-in. Redirects home once a session exists (or auth is off). */
export function LoginRoute() {
  const { authRequired, user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && (!authRequired || user)) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dark flex h-full w-full items-center justify-center bg-bg px-4 text-text">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-[320px] rounded-[4px] border border-line bg-panel p-6 font-mono"
      >
        <div className="mb-5 text-[13px] font-medium tracking-[.02em] text-dim">fleet / sign in</div>

        <label className="mb-1 block text-[10.5px] uppercase tracking-[.08em] text-dim">username</label>
        <input
          className="mb-3 w-full rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[12px] text-text outline-none focus:border-dim"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
        />

        <label className="mb-1 block text-[10.5px] uppercase tracking-[.08em] text-dim">password</label>
        <input
          className="mb-4 w-full rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[12px] text-text outline-none focus:border-dim"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />

        {error && <div className="mb-3 text-[11px] text-term-err">{error}</div>}

        <button
          type="submit"
          disabled={submitting || !username || !password}
          className="w-full rounded-[3px] border border-line bg-panel2 px-3 py-2 text-[11px] font-medium text-text transition-colors hover:bg-line disabled:opacity-50"
        >
          {submitting ? "signing in…" : "sign in"}
        </button>
      </form>
    </div>
  );
}
