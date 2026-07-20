import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";

/** Overlay that marks the current nav item: accent wash + accent left border. */
function ActiveFill() {
  return (
    <span className="pointer-events-none absolute inset-0 rounded-[3px] border-l-2 border-accent bg-accent-soft" />
  );
}

const navItemClass =
  "relative flex w-full items-center gap-[9px] rounded-[3px] px-[10px] py-[9px] text-left font-mono transition-colors hover:bg-panel2";

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { repos, workspaces, liveCount } = useFleet();

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex h-full w-[220px] flex-none flex-col border-r border-line bg-panel transition-transform duration-200 md:static md:z-auto md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="border-b border-line px-4 pb-[15px] pt-[17px]">
        <div className="font-mono text-[12.5px] font-bold tracking-[.16em] text-text">◤ ORCHESTRA</div>
        <div className="mt-1 font-mono text-[9.5px] tracking-[.14em] text-dim2">AGENT CONTROL</div>
      </div>

      <nav onClick={onClose} className="flex flex-1 flex-col gap-0.5 overflow-auto px-2 py-[11px]">
        <NavLink to="/" end className={navItemClass}>
          {({ isActive }) => (
            <>
              {isActive && <ActiveFill />}
              <span className="relative z-[1] text-[13px] text-text">⌂</span>
              <span className="relative z-[1] text-[12px] font-semibold tracking-[.06em] text-text">Bridge</span>
            </>
          )}
        </NavLink>

        <NavLink to="/repos" className={navItemClass}>
          {({ isActive }) => (
            <>
              {isActive && <ActiveFill />}
              <span className="relative z-[1] text-[13px] text-text">▣</span>
              <span className="relative z-[1] text-[12px] font-semibold tracking-[.06em] text-text">Repos</span>
            </>
          )}
        </NavLink>

        <NavLink to="/ships" className={navItemClass}>
          {({ isActive }) => (
            <>
              {isActive && <ActiveFill />}
              <span className="relative z-[1] text-[13px] text-text">▦</span>
              <span className="relative z-[1] text-[12px] font-semibold tracking-[.06em] text-text">Ships</span>
            </>
          )}
        </NavLink>

        <div className="px-[10px] pb-[7px] pt-[15px] font-mono text-[9.5px] font-semibold tracking-[.18em] text-dim2">
          REPOS
        </div>

        {repos.map((r) => (
          <NavLink
            key={r.name}
            to={`/repos/${r.name}`}
            className="relative flex w-full items-center gap-2 rounded-[3px] px-[10px] py-[7px] text-left font-mono transition-colors hover:bg-panel2"
          >
            {({ isActive }) => (
              <>
                {isActive && <ActiveFill />}
                <span className="relative z-[1] flex-1 text-[11.5px] text-text">{r.name}</span>
                <span className="relative z-[1] text-[10px] text-dim2">
                  {workspaces.filter((w) => w.repoName === r.name).length}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="flex items-center gap-2 border-t border-line px-[14px] py-[12px]">
        <span className={cn("h-1.5 w-1.5 rounded-full bg-accent")} />
        <span className="font-mono text-[9.5px] text-dim">{liveCount} sessions live</span>
      </div>
    </aside>
  );
}
