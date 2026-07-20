import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { useFleet } from "@/data/FleetContext";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";

const COLS = "1fr 1.6fr 110px 34px";

export function ReposRoute() {
  const { repos, createRepo, deleteRepo } = useFleet();
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <div className="px-4 pb-16 pt-5 sm:px-[30px] sm:pb-[60px] sm:pt-[28px]">
      <Link to="/" className="font-mono text-[11px] font-medium text-dim transition-colors hover:text-text">
        ← bridge
      </Link>

      <div className="mb-[22px] mt-[14px] flex flex-wrap items-start justify-between gap-[18px]">
        <div>
          <h1 className="font-mono text-[22px] font-bold text-text">▣ Repos</h1>
          <p className="mt-2 font-prose text-[12.5px] text-dim">
            Repos the fleet can create workspaces from.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md border border-line bg-panel px-[14px] py-[8px] font-mono text-[11px] font-semibold text-text transition-colors hover:bg-panel2"
        >
          + New Repo
        </button>
      </div>

      <div className="overflow-hidden rounded-md border border-line bg-panel">
        <div
          className="hidden gap-3 bg-bg px-4 py-[10px] font-mono text-[9px] font-semibold tracking-[.14em] text-dim2 md:grid"
          style={{ gridTemplateColumns: COLS }}
        >
          <span>NAME</span>
          <span>URL</span>
          <span>PROVIDER</span>
          <span />
        </div>

        {repos.length === 0 && (
          <div className="border-t border-line px-4 py-[18px] font-mono text-[11px] text-dim2">
            No repos registered yet.
          </div>
        )}

        {repos.map((r) => (
          <div
            key={r.name}
            className="relative flex flex-col gap-1.5 border-t border-line px-4 py-[13px] font-mono md:grid md:items-center md:gap-3"
            style={{ gridTemplateColumns: COLS }}
          >
            <span className="text-[12px] font-semibold text-text">▣ {r.name}</span>
            <span className="min-w-0 break-all text-[11px] text-dim md:overflow-hidden md:text-ellipsis md:whitespace-nowrap md:break-normal">
              <RowLabel>URL</RowLabel>
              {r.url}
            </span>
            <span className="text-[10.5px] text-dim2">
              <RowLabel>PROVIDER</RowLabel>
              {r.provider}
            </span>
            <button
              type="button"
              onClick={() => setPendingDelete(r.name)}
              aria-label={`Delete ${r.name}`}
              className="absolute right-2 top-2 flex items-center justify-center rounded p-2 text-dim2 transition-colors hover:bg-panel2 hover:text-red-400 md:static md:p-[5px]"
            >
              <Trash2 className="size-[15px]" />
            </button>
          </div>
        ))}
      </div>

      {creating && <CreateRepoModal onClose={() => setCreating(false)} onCreate={createRepo} />}
      {pendingDelete && (
        <ConfirmDeleteModal
          name={pendingDelete}
          kind="repo"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => deleteRepo(pendingDelete)}
        />
      )}
    </div>
  );
}

function CreateRepoModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; url: string; provider?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState("github");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), url: url.trim(), provider: provider.trim() || undefined });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open title="New Repo" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="api-gateway" autoFocus />
        </Field>
        <Field label="URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:org/repo.git" />
        </Field>
        <Field label="Provider">
          <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="github" />
        </Field>
        {error && <p className="font-mono text-[11px] text-red-400">{error}</p>}
        <ModalActions
          onCancel={onClose}
          confirmLabel="Create"
          pending={pending}
          disabled={!name.trim() || !url.trim()}
        />
      </form>
    </Modal>
  );
}

export function ConfirmDeleteModal({
  name,
  kind,
  onClose,
  onConfirm,
}: {
  name: string;
  kind: "repo" | "ship";
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open title={`Delete ${kind}`} onClose={onClose}>
      <p className="font-prose text-[13px] text-text">
        Delete <span className="font-mono font-semibold">{name}</span>? This cannot be undone.
      </p>
      {error && <p className="mt-3 font-mono text-[11px] text-red-400">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line bg-panel px-[14px] py-[7px] font-mono text-[11px] font-semibold text-dim transition-colors hover:bg-panel2 hover:text-text"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={pending}
          className="rounded-md bg-red-500/90 px-[14px] py-[7px] font-mono text-[11px] font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}

/** Mobile-only inline field label for the stacked-card table rows (hidden at `md`). */
export function RowLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mr-2 font-mono text-[9px] font-semibold tracking-[.14em] text-dim2 md:hidden">
      {children}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold tracking-[.12em] text-dim2">{label.toUpperCase()}</span>
      {children}
    </label>
  );
}

export function ModalActions({
  onCancel,
  confirmLabel,
  pending,
  disabled,
}: {
  onCancel: () => void;
  confirmLabel: string;
  pending: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="mt-2 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-line bg-panel px-[14px] py-[7px] font-mono text-[11px] font-semibold text-dim transition-colors hover:bg-panel2 hover:text-text"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={pending || disabled}
        className="rounded-md bg-accent px-[14px] py-[7px] font-mono text-[11px] font-semibold text-black transition-colors hover:brightness-110 disabled:opacity-50"
      >
        {pending ? "Saving…" : confirmLabel}
      </button>
    </div>
  );
}
