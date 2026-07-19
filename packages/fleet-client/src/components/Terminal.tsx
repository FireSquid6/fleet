import { useEffect, useState } from "react";
import type { WorkspaceDiff } from "fleet-protocol";
import { useFleet } from "@/data/FleetContext";
import { TerminalGrid } from "@/components/TerminalGrid";

interface TerminalProps {
  repo: string;
  name: string;
  ship: string;
  branch: string;
  active: boolean;
  onActivate: () => void;
}

export function Terminal({ repo, name, ship, branch, active, onActivate }: TerminalProps) {
  const { getWorkspace } = useFleet();
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);

  useEffect(() => {
    if (!active) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const detail = await getWorkspace(repo, name);
      if (cancelled) return;
      setDiff(detail.state === "active" ? detail.diff : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, repo, name, getWorkspace]);

  const footer = active
    ? `⎇ ${branch}   ·   ↑${diff?.commits ?? 0} ↓0   ·   +${diff?.added ?? 0} −${diff?.removed ?? 0}   ·   last exit 0   ·   uptime 00:12:47`
    : `⎇ ${branch}   ·   session stopped   ·   last active 14m ago`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-term-bg">
      <div className="flex flex-none items-center justify-between gap-3 border-b border-term-line bg-term-chrome px-[14px] py-[9px]">
        <div className="flex items-center gap-[10px]">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-term-err" />
            <span className="h-2.5 w-2.5 rounded-full bg-term-warn" />
            <span className="h-2.5 w-2.5 rounded-full bg-term-cmd" />
          </span>
          <span className="font-mono text-[10.5px] font-medium text-[#8b949e]">
            {name} — agent@{ship}
          </span>
        </div>
        <span className="font-mono text-[10px] text-[#4d5560]">tty/0 · utf-8</span>
      </div>

      {active ? (
        <TerminalGrid repo={repo} name={name} active={active} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[15px] bg-term-bg p-10 text-center">
          <div className="font-mono text-[30px] leading-none text-[#3a424c]">◼</div>
          <div className="font-mono text-[15px] font-bold tracking-[.05em] text-[#9aa4af]">Workspace Inactive</div>
          <div className="max-w-[360px] font-mono text-[11.5px] leading-[1.6] text-[#4d5560]">
            No agent session is attached. Activate to spin one up on ▦ {ship} against ⎇ {branch}.
          </div>
          <button
            type="button"
            onClick={onActivate}
            className="mt-1 rounded-[4px] bg-accent px-5 py-[9px] font-mono text-[12px] font-bold text-[#06140b] transition-[filter] hover:brightness-110"
          >
            ▸ Activate session
          </button>
        </div>
      )}

      <div className="flex-none border-t border-term-line bg-term-chrome px-[14px] py-[7px] font-mono text-[10px] text-term-footer">
        {footer}
      </div>
    </div>
  );
}
