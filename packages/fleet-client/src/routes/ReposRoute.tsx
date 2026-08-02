import { useState, type ReactNode } from "react";
import { useFleet } from "@/data/FleetContext";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { COLS, RegistryPage } from "@/components/RegistryPage";
import { useSubmitAction } from "@/lib/useSubmitAction";

export function ReposRoute() {
  const { repos, createRepo, deleteRepo } = useFleet();
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <RegistryPage
      glyph="▣"
      title="Repos"
      blurb="Repos the fleet can create workspaces from."
      newLabel="+ New Repo"
      onNew={() => setCreating(true)}
      cols={COLS}
      columns={
        <>
          <span>NAME</span>
          <span>URL</span>
          <span>PROVIDER</span>
        </>
      }
      empty="No repos registered yet."
      rows={repos}
      rowKey={(r) => r.name}
      onDelete={(r) => setPendingDelete(r.name)}
      renderRow={(r) => (
        <>
          <span className="text-[12px] font-semibold text-text">▣ {r.name}</span>
          <span className="min-w-0 break-all text-[11px] text-dim md:overflow-hidden md:text-ellipsis md:whitespace-nowrap md:break-normal">
            <RowLabel>URL</RowLabel>
            {r.url}
          </span>
          <span className="text-[10.5px] text-dim2">
            <RowLabel>PROVIDER</RowLabel>
            {r.provider}
          </span>
        </>
      )}
    >
      {creating && <CreateRepoModal onClose={() => setCreating(false)} onCreate={createRepo} />}
      {pendingDelete && (
        <ConfirmDeleteModal
          name={pendingDelete}
          kind="repo"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => deleteRepo(pendingDelete)}
        />
      )}
    </RegistryPage>
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
  const { error, pending, submit } = useSubmitAction(
    () => onCreate({ name: name.trim(), url: url.trim(), provider: provider.trim() || undefined }),
    onClose,
  );

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
  kind: "repo" | "ship" | "workspace";
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { error, pending, submit } = useSubmitAction(onConfirm, onClose);

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
          onClick={() => submit()}
          disabled={pending}
          className="rounded-md bg-red-500/90 px-[14px] py-[7px] font-mono text-[11px] font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}

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
