import { useState } from "react";
import { useFleet } from "@/data/FleetContext";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Field, ModalActions } from "@/routes/ReposRoute";
import { useSubmitAction } from "@/lib/useSubmitAction";

interface Props {
  repo: string;
  name: string;
  currentBranch: string;
  onClose: () => void;
}

export function SwitchBranchModal({ repo, name, currentBranch, onClose }: Props) {
  const { switchBranch } = useFleet();
  const [branch, setBranch] = useState(currentBranch);
  const { error, pending, submit } = useSubmitAction(() => switchBranch(repo, name, branch.trim()), onClose);

  const target = branch.trim();

  return (
    <Modal open title="Switch Branch" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Branch">
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoFocus />
        </Field>
        {error && <p className="font-mono text-[11px] text-red-400">{error}</p>}
        <ModalActions
          onCancel={onClose}
          confirmLabel="Switch"
          pending={pending}
          disabled={!target || target === currentBranch}
        />
      </form>
    </Modal>
  );
}
