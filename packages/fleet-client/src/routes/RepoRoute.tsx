import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";
import { CreateWorkspaceModal } from "@/components/CreateWorkspaceModal";
import { RowLabel } from "./ReposRoute";

const COLS = "150px 1.3fr 1fr 118px";

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 px-[18px] py-[11px]">
      <span className={cn("font-mono text-[18px] font-bold", accent ? "text-accent" : "text-text")}>{value}</span>
      <span className="font-mono text-[9px] tracking-[.13em] text-dim2">{label}</span>
    </div>
  );
}

export function RepoRoute() {
  const { repo = "" } = useParams();
  const { ships, workspaces } = useFleet();
  const [creating, setCreating] = useState(false);

  const shipOrder = ships.map((s) => s.name);
  const shipSpec = (name: string) => ships.find((s) => s.name === name)?.spec ?? "";

  const rows = workspaces
    .filter((w) => w.repoName === repo)
    .sort(
      (a, b) =>
        shipOrder.indexOf(a.ship) - shipOrder.indexOf(b.ship) || Number(b.active) - Number(a.active),
    );

  const activeCount = rows.filter((w) => w.active).length;
  const shipCount = new Set(rows.map((w) => w.ship)).size;

  return (
    <div className="px-4 pb-16 pt-5 sm:px-[30px] sm:pb-[60px] sm:pt-[28px]">
      <Link
        to="/"
        className="font-mono text-[11px] font-medium text-dim transition-colors hover:text-text"
      >
        ← bridge
      </Link>

      <div className="mb-[22px] mt-[14px] flex flex-wrap items-start justify-between gap-[18px]">
        <div>
          <h1 className="font-mono text-[22px] font-bold text-text">▣ {repo}</h1>
          <p className="mt-2 font-prose text-[12.5px] text-dim">
            All workspaces for this repo and the ship each one is running on.
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-3 rounded-md border border-line bg-panel px-[14px] py-[8px] font-mono text-[11px] font-semibold text-text transition-colors hover:bg-panel2"
          >
            + New Workspace
          </button>
        </div>
        <div className="flex w-full flex-col overflow-hidden rounded-md border border-line bg-panel sm:w-auto sm:flex-row">
          <Stat label="WORKSPACES" value={rows.length} />
          <div className="h-px w-full bg-line sm:h-auto sm:w-px" />
          <Stat label="ACTIVE" value={activeCount} accent />
          <div className="h-px w-full bg-line sm:h-auto sm:w-px" />
          <Stat label="SHIPS" value={shipCount} />
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-line bg-panel">
        <div
          className="hidden gap-3 bg-bg px-4 py-[10px] font-mono text-[9px] font-semibold tracking-[.14em] text-dim2 md:grid"
          style={{ gridTemplateColumns: COLS }}
        >
          <span>WORKSPACE</span>
          <span>BRANCH</span>
          <span>SHIP</span>
          <span className="text-right">STATUS</span>
        </div>

        {rows.map((w) => (
          <Link
            key={w.name}
            to={`/repos/${encodeURIComponent(w.repoName)}/workspaces/${encodeURIComponent(w.name)}`}
            className={cn(
              "flex flex-col gap-1.5 border-t border-l-2 border-line px-4 py-[13px] font-mono transition-colors hover:bg-panel2 md:grid md:items-center md:gap-3",
              w.active ? "border-l-accent" : "border-l-transparent",
            )}
            style={{ gridTemplateColumns: COLS }}
          >
            <span className="text-[12px] font-semibold text-text">◇ {w.name}</span>
            <span className="min-w-0 break-all text-[11px] text-dim md:overflow-hidden md:text-ellipsis md:whitespace-nowrap md:break-normal">
              <RowLabel>BRANCH</RowLabel>
              ⎇ {w.branch}
            </span>
            <span className="flex min-w-0 items-baseline gap-2 md:flex-col md:items-start md:gap-0.5">
              <RowLabel>SHIP</RowLabel>
              <span className="text-[11px] font-medium text-text">▦ {w.ship}</span>
              <span className="text-[9px] text-dim2">{shipSpec(w.ship)}</span>
            </span>
            <span className="flex items-center gap-[7px] text-[10.5px] font-medium text-dim md:justify-end">
              <RowLabel>STATUS</RowLabel>
              <span className={cn("h-1.5 w-1.5 flex-none rounded-full", w.active ? "bg-accent" : "bg-dim2")} />
              {w.active ? "active" : "inactive"}
            </span>
          </Link>
        ))}
      </div>

      {creating && <CreateWorkspaceModal repoName={repo} onClose={() => setCreating(false)} />}
    </div>
  );
}
