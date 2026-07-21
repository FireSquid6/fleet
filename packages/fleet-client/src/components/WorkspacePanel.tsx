import { useState } from "react";
import { cn } from "@/lib/utils";
import { Terminal } from "@/components/Terminal";
import { DiffView } from "@/components/DiffView";

interface WorkspacePanelProps {
  repo: string;
  name: string;
  ship: string;
  branch: string;
  active: boolean;
  onActivate: () => void;
}

type Tab = "terminal" | "diff";

/**
 * The workspace's main pane: a Terminal/Diff tab switcher. Each tab is mounted
 * only while selected — the terminal re-attaches its (server-persistent tmux)
 * session on switch-back, and the diff is fetched fresh when its tab opens.
 */
export function WorkspacePanel({ repo, name, ship, branch, active, onActivate }: WorkspacePanelProps) {
  const [tab, setTab] = useState<Tab>("terminal");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-[10px] flex items-center gap-2">
        {(["terminal", "diff"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-[4px] border px-[13px] py-[6px] font-mono text-[11px] font-semibold transition-[filter] hover:brightness-[1.13]",
              tab === t ? "border-accent bg-accent-soft text-text" : "border-line text-dim",
            )}
          >
            {t === "terminal" ? "▤ Terminal" : "◧ Diff"}
          </button>
        ))}
      </div>

      {tab === "terminal" ? (
        <Terminal repo={repo} name={name} ship={ship} branch={branch} active={active} onActivate={onActivate} />
      ) : (
        <DiffView repo={repo} name={name} />
      )}
    </div>
  );
}
