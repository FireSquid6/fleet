import { Link, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";

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
    <div className="px-[30px] pb-[60px] pt-[28px]">
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
        </div>
        <div className="flex overflow-hidden rounded-md border border-line bg-panel">
          <Stat label="WORKSPACES" value={rows.length} />
          <div className="w-px bg-line" />
          <Stat label="ACTIVE" value={activeCount} accent />
          <div className="w-px bg-line" />
          <Stat label="SHIPS" value={shipCount} />
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-line bg-panel">
        <div
          className="grid gap-3 bg-bg px-4 py-[10px] font-mono text-[9px] font-semibold tracking-[.14em] text-dim2"
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
            to={`/repos/${w.repoName}/workspaces/${w.name}`}
            className={cn(
              "grid items-center gap-3 border-t border-l-2 border-line px-4 py-[13px] font-mono transition-colors hover:bg-panel2",
              w.active ? "border-l-accent" : "border-l-transparent",
            )}
            style={{ gridTemplateColumns: COLS }}
          >
            <span className="text-[12px] font-semibold text-text">◇ {w.name}</span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-dim">
              ⎇ {w.branch}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[11px] font-medium text-text">▦ {w.ship}</span>
              <span className="text-[9px] text-dim2">{shipSpec(w.ship)}</span>
            </span>
            <span className="flex items-center justify-end gap-[7px] text-[10.5px] font-medium text-dim">
              <span className={cn("h-1.5 w-1.5 flex-none rounded-full", w.active ? "bg-accent" : "bg-dim2")} />
              {w.active ? "active" : "inactive"}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
