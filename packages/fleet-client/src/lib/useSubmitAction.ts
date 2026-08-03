import { useState, type FormEvent } from "react";

export function useSubmitAction(action: () => Promise<void>, onClose: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setPending(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return { error, pending, submit };
}
