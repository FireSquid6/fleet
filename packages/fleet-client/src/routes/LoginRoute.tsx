import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/data/AuthContext";
import { loginCredentials, loginErrorMessage } from "@/lib/login";
import { Field } from "./ReposRoute";

export function LoginRoute() {
  const { signIn, error: bootError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const credentials = loginCredentials({ username, password });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!credentials) return;
    setPending(true);
    setError(null);
    try {
      await signIn(credentials.username, credentials.password);
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-bg px-4 font-prose text-text">
      <form
        onSubmit={submit}
        className="flex w-full max-w-[340px] flex-col gap-3 rounded-md border border-line bg-panel p-6"
      >
        <div className="mb-1">
          <h1 className="font-mono text-[13px] font-semibold tracking-[.02em] text-text">fleet</h1>
          <p className="mt-1 font-mono text-[11px] text-dim">sign in to the bridge</p>
        </div>
        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {(error ?? bootError) && (
          <p className="font-mono text-[11px] text-red-400">{error ?? bootError}</p>
        )}
        <button
          type="submit"
          disabled={pending || !credentials}
          className="mt-2 rounded-md bg-accent px-[14px] py-[7px] font-mono text-[11px] font-semibold text-black transition-colors hover:brightness-110 disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
