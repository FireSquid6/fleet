import { Link, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";
import { Terminal } from "@/components/Terminal";

export function WorkspaceRoute() {
  const { repo = "", name = "" } = useParams();
  const { workspaces, activate, deactivate } = useFleet();
  const ws = workspaces.find((w) => w.repoName === repo && w.name === name);

  if (!ws) {
    return <div className="px-[30px] py-[28px] font-mono text-[12px] text-dim">workspace not found</div>;
  }

  const active = ws.active;
  const siblings = workspaces.filter((w) => w.repoName === repo);

  return (
    <div className="flex h-full flex-col px-4 pb-4 pt-5 sm:px-[30px] sm:pb-6 sm:pt-[24px]">
      <Link
        to={`/repos/${repo}`}
        className="self-start font-mono text-[11px] font-medium text-dim transition-colors hover:text-text"
      >
        ← {repo}
      </Link>

      <div className="mb-[14px] mt-[13px] flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-[15px]">
          <h1 className="font-mono text-[20px] font-bold text-text">◇ {name}</h1>
          <span className="font-mono text-[11.5px] text-dim">{repo}</span>
          <span className="font-mono text-[11.5px] text-dim">⎇ {ws.branch}</span>
          <span className="font-mono text-[11.5px] text-dim">▦ {ws.ship}</span>
        </div>
        <div className="flex items-center gap-[10px]">
          <span className="flex items-center gap-[7px] rounded-[4px] border border-line px-[11px] py-[5px] font-mono text-[10px] font-semibold tracking-[.11em] text-dim">
            <span className={cn("h-[7px] w-[7px] rounded-full", active ? "bg-accent" : "bg-dim2")} />
            {active ? "ACTIVE" : "INACTIVE"}
          </span>
          {active ? (
            <button
              type="button"
              onClick={() => deactivate(repo, name)}
              className="rounded-[4px] border border-line px-[13px] py-[6px] font-mono text-[11px] font-semibold text-text transition-[filter] hover:brightness-[1.18]"
            >
              ◼ Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => activate(repo, name)}
              className="rounded-[4px] bg-accent px-[15px] py-[6px] font-mono text-[11px] font-bold text-[#06140b] transition-[filter] hover:brightness-110"
            >
              ▸ Activate
            </button>
          )}
        </div>
      </div>

      <div className="mb-[14px] flex items-center gap-2 overflow-x-auto pb-[3px]">
        <span className="flex-none font-mono text-[9px] font-semibold tracking-[.14em] text-dim2">SIBLINGS</span>
        {siblings.map((s) => {
          const current = s.name === name;
          return (
            <Link
              key={s.name}
              to={`/repos/${repo}/workspaces/${s.name}`}
              className={cn(
                "flex flex-none items-center gap-2 whitespace-nowrap rounded-[4px] border px-3 py-[7px] font-mono text-text transition-[filter] hover:brightness-[1.13]",
                current ? "border-accent bg-accent-soft" : "border-line bg-transparent",
              )}
            >
              <span className={cn("h-1.5 w-1.5 flex-none rounded-full", s.active ? "bg-accent" : "bg-dim2")} />
              <span className="text-[11px]">⎇ {s.branch}</span>
              <span className="text-[9.5px] text-dim2">{s.name}</span>
            </Link>
          );
        })}
      </div>

      <Terminal
        repo={repo}
        name={name}
        ship={ws.ship}
        branch={ws.branch}
        active={active}
        onActivate={() => activate(repo, name)}
      />
    </div>
  );
}
