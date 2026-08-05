import { useEffect, useState, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { COLS, RegistryPage } from "@/components/RegistryPage";
import { createShipInput, generateShipTokens } from "@/lib/create-ship";
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
  onCreate: (url: string, credentials?: { shipToken?: string; bridgeToken?: string }) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [shipToken, setShipToken] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");

  const input = createShipInput({ url, shipToken, bridgeToken });
  const { error, pending, submit } = useSubmitAction(() => {
    const { url: target, ...credentials } = input!;
    return onCreate(target, credentials);
  }, onClose);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (input && !pending) void submit();
  };

  const generate = () => {
    const tokens = generateShipTokens();
    setShipToken(tokens.shipToken);
    setBridgeToken(tokens.bridgeToken);
  };

  return (
    <Modal open title="New Ship" onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://ship-host:4700" autoFocus />
        </Field>
        <p className="font-prose text-[11px] text-dim2">
          The bridge connects to this URL and learns the ship's name on first sync.
        </p>

        <div className="mt-1 flex items-center justify-between border-t border-line pt-3">
          <span className="font-mono text-[10px] font-semibold tracking-[.12em] text-dim2">
            CREDENTIALS (OPTIONAL)
          </span>
          <button
            type="button"
            onClick={generate}
            className="rounded-md border border-line bg-panel px-[10px] py-[5px] font-mono text-[10px] font-semibold text-dim transition-colors hover:bg-panel2 hover:text-text"
          >
            Generate
          </button>
        </div>
        <SecretField label="Ship token" value={shipToken} onChange={setShipToken} />
        <SecretField label="Bridge token" value={bridgeToken} onChange={setBridgeToken} />
        <p className="font-prose text-[11px] text-dim2">
          Leave both blank to register a ship that talks to the bridge unauthenticated. Otherwise set both, and
          start the ship with <span className="font-mono">FLEET_BRIDGE_TOKEN</span> set to the bridge token.
          Copy them before you create — the bridge keeps only a hash of the ship token and can never show
          either again.
        </p>

        {error && <p className="font-mono text-[11px] text-red-400">{error}</p>}
        <ModalActions onCancel={onClose} confirmLabel="Create" pending={pending} disabled={!input} />
      </form>
    </Modal>
  );
}

function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold tracking-[.12em] text-dim2">
        {label.toUpperCase()}
      </span>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="blank for none"
        />
        <button
          type="button"
          onClick={() => void copy()}
          disabled={value.length === 0}
          className="w-[76px] flex-none rounded-md border border-line bg-panel px-[10px] py-[7px] font-mono text-[10px] font-semibold text-dim transition-colors hover:bg-panel2 hover:text-text disabled:opacity-40 disabled:hover:bg-panel disabled:hover:text-dim"
        >
          {status === "copied" ? "Copied" : status === "failed" ? "Failed" : "Copy"}
        </button>
      </div>
    </div>
  );
}
