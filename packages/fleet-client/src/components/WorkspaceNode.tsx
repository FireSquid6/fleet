import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/data/types";

/**
 * A workspace tile in the Bridge grid. The outline/active fill and radius come
 * from the `--node-*` tokens (a border shorthand, so applied via inline style).
 */
export function WorkspaceNode({ ws }: { ws: Workspace }) {
  return (
    <Link
      to={`/repos/${encodeURIComponent(ws.repoName)}/workspaces/${encodeURIComponent(ws.name)}`}
      className="flex w-full flex-col gap-1 rounded-[var(--node-radius)] px-[9px] py-2 font-mono transition-[filter] hover:brightness-[1.14]"
      style={{
        background: ws.active ? "var(--node-bg-active)" : "var(--node-bg)",
        border: ws.active ? "var(--node-border-active)" : "var(--node-border)",
      }}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-[11px] font-semibold text-text">{ws.repoName}</span>
        <span className={cn("h-1.5 w-1.5 flex-none rounded-full", ws.active ? "bg-accent" : "bg-dim2")} />
      </div>
      <div className="text-[10px] text-dim">⎇ {ws.branch}</div>
      <div className="text-[9.5px] text-dim2">
        {ws.name} · {ws.active ? "active" : "inactive"}
      </div>
    </Link>
  );
}
