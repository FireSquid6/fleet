import { useState } from "react";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { COLS, RegistryPage } from "@/components/RegistryPage";
import { useSubmitAction } from "@/lib/useSubmitAction";
import { ConfirmDeleteModal, Field, ModalActions, RowLabel } from "./ReposRoute";

export function ShipsRoute() {
  const { ships, createShip, deleteShip } = useFleet();
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <RegistryPage
      glyph="▦"
      title="Ships"
      blurb="Hosts the bridge connects to for running workspaces."
      newLabel="+ New Ship"
      onNew={() => setCreating(true)}
      cols={COLS}
      columns={
        <>
          <span>NAME</span>
          <span>SPEC</span>
          <span className="text-right">STATUS</span>
        </>
      }
      empty="No ships registered yet."
      rows={ships}
      rowKey={(s) => s.name}
      onDelete={(s) => setPendingDelete(s.name)}
      renderRow={(s) => (
        <>
          <span className="text-[12px] font-semibold text-text">▦ {s.name}</span>
          <span className="min-w-0 break-all text-[11px] text-dim md:overflow-hidden md:text-ellipsis md:whitespace-nowrap md:break-normal">
            <RowLabel>SPEC</RowLabel>
            {s.spec}
          </span>
          <span className="flex items-center gap-[7px] text-[10.5px] font-medium text-dim md:justify-end">
            <RowLabel>STATUS</RowLabel>
            <span
              className={cn("h-1.5 w-1.5 flex-none rounded-full", s.status === "online" ? "bg-accent" : "bg-dim2")}
            />
            {s.status}
          </span>
        </>
      )}
    >
      {creating && <CreateShipModal onClose={() => setCreating(false)} onCreate={createShip} />}
      {pendingDelete && (
        <ConfirmDeleteModal
          name={pendingDelete}
          kind="ship"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => deleteShip(pendingDelete)}
        />
      )}
    </RegistryPage>
  );
}

function CreateShipModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const { error, pending, submit } = useSubmitAction(() => onCreate(url.trim()), onClose);

  return (
    <Modal open title="New Ship" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://ship-host:4800" autoFocus />
        </Field>
        <p className="font-prose text-[11px] text-dim2">
          The bridge connects to this URL and learns the ship's name on first sync.
        </p>
        {error && <p className="font-mono text-[11px] text-red-400">{error}</p>}
        <ModalActions onCancel={onClose} confirmLabel="Create" pending={pending} disabled={!url.trim()} />
      </form>
    </Modal>
  );
}
