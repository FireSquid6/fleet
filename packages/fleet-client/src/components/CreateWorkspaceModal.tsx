import { useState, type FormEvent } from "react";
import { useFleet } from "@/data/FleetContext";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Field, ModalActions } from "@/routes/ReposRoute";

interface Props {
  repoName: string;
  /** When set, the ship is fixed (Bridge cell entry); otherwise a dropdown is shown. */
  ship?: string;
  onClose: () => void;
}

export function CreateWorkspaceModal({ repoName, ship, onClose }: Props) {
  const { ships, createWorkspace } = useFleet();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const [selectedShip, setSelectedShip] = useState(ship ?? ships[0]?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const shipName = ship ?? selectedShip;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createWorkspace({ ship: shipName, repoName, name: name.trim(), branch: branch.trim() });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open title="New Workspace" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Repo">
          <div className="font-mono text-[12px] text-text">▣ {repoName}</div>
        </Field>

        <Field label="Ship">
          {ship ? (
            <div className="font-mono text-[12px] text-text">▦ {ship}</div>
          ) : (
            <select
              value={selectedShip}
              onChange={(e) => setSelectedShip(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-[12px] text-text outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {ships.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="feature-x" autoFocus />
        </Field>
        <Field label="Branch">
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
        </Field>

        {error && <p className="font-mono text-[11px] text-red-400">{error}</p>}
        <ModalActions
          onCancel={onClose}
          confirmLabel="Create"
          pending={pending}
          disabled={!name.trim() || !branch.trim() || !shipName}
        />
      </form>
    </Modal>
  );
}
