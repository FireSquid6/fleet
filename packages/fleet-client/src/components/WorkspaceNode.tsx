import { Link } from "react-router-dom";
import type { Workspace } from "@/data/types";
import { agentStateColor } from "@/lib/agent-status";

/**
 * A workspace tile in the Bridge grid. The outline/active fill and radius come
 * from the `--node-*` tokens (a border shorthand, so applied via inline style).
 */
export function WorkspaceNode({ ws }: { ws: Workspace }) {
  const color = ws.agent ? agentStateColor(ws.agent.state) : ws.active ? "var(--dim)" : "var(--line)";

  return (
    <Link
      to={`/repos/${encodeURIComponent(ws.repoName)}/workspaces/${encodeURIComponent(ws.name)}`}
      className="flex w-full flex-col gap-1 rounded-[var(--node-radius)] px-[9px] py-2 font-mono transition-[filter] hover:brightness-[1.14]"
      style={{
        background: "var(--node-bg)",
        border: `1px solid ${color}`,
      }}
    >
      <span className="text-[11px] font-semibold text-text">{ws.repoName}</span>
      <div className="text-[10px] text-dim">⎇ {ws.branch}</div>
      <div className="text-[9.5px] text-dim2">{ws.name} · {ws.active ? "active" : "inactive"}</div>
      {ws.active && (
        <div className="mt-0.5 min-w-0 text-[9.5px]" style={{ color }}>
          <span className="font-semibold uppercase tracking-[.08em]">{ws.agent?.state ?? "no agent"}</span>
          {ws.agent && <span className="ml-1.5 block overflow-hidden text-ellipsis whitespace-nowrap" title={ws.agent.description}>{ws.agent.description}</span>}
        </div>
      )}
    </Link>
  );
}
