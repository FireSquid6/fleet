import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useFleet } from "@/data/FleetContext";
import { useIsMobile } from "@/lib/useIsMobile";
import { WorkspaceNode } from "@/components/WorkspaceNode";
import { CreateWorkspaceModal } from "@/components/CreateWorkspaceModal";

export function BridgeRoute() {
  const { ships, repos, workspaces } = useFleet();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState<{ repoName: string; ship: string } | null>(null);

  const totalWs = workspaces.length;
  const activeWs = workspaces.filter((w) => w.active).length;
  const activeInRepo = (repo: string) => workspaces.filter((w) => w.repoName === repo && w.active).length;
  const cellWorkspaces = (repo: string, ship: string) =>
    workspaces.filter((w) => w.repoName === repo && w.ship === ship);

  return (
    <div className="px-4 pb-16 pt-5 sm:px-[30px] sm:pb-[60px] sm:pt-[28px]">
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-[21px] font-bold tracking-[.01em] text-text">Bridge</h1>
        </div>
        <div className="whitespace-nowrap font-mono text-[12px] text-dim">
          <span className="text-[15px] font-bold text-accent">{activeWs}</span> / {totalWs} sessions active
        </div>
      </div>

      {isMobile ? (
        <div className="flex flex-col gap-3">
          {repos.map((r) => (
            <div key={r.name} className="overflow-hidden rounded-md border border-line bg-panel">
              <Link
                to={`/repos/${encodeURIComponent(r.name)}`}
                className="flex items-center justify-between gap-2 border-b border-line px-4 py-[13px] transition-colors hover:bg-panel2"
              >
                <span className="font-mono text-[13px] font-semibold text-text">{r.name}</span>
                <span className="font-mono text-[10px] text-dim2">{activeInRepo(r.name)} active&nbsp;&nbsp;↗</span>
              </Link>
              {ships.map((s) => (
                <div key={s.name} className="border-t border-line px-4 py-[11px] first:border-t-0">
                  <div className="flex items-baseline gap-2 font-mono">
                    <span className="text-[11.5px] font-bold text-text">▦ {s.name}</span>
                    <span className="text-[9.5px] text-dim2">{s.spec}</span>
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    {cellWorkspaces(r.name, s.name).map((w) => (
                      <WorkspaceNode key={w.name} ws={w} />
                    ))}
                    <button
                      type="button"
                      onClick={() => setCreating({ repoName: r.name, ship: s.name })}
                      aria-label={`New workspace for ${r.name} on ${s.name}`}
                      className="rounded-[var(--node-radius)] border border-dashed border-line py-[9px] font-mono text-[11px] text-dim2 transition-colors hover:border-accent hover:text-text"
                    >
                      ＋ new workspace
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="grid overflow-hidden rounded-md border border-line bg-panel"
          style={{ gridTemplateColumns: `190px repeat(${ships.length}, minmax(160px, 1fr))` }}
        >
          <div className="flex items-end border-b border-r border-line bg-panel px-[13px] py-[11px] font-mono text-[9.5px] font-semibold tracking-[.13em] text-dim2">
            REPO ╱ SHIP
          </div>
          {ships.map((s) => (
            <div key={s.name} className="border-b border-r border-line bg-panel px-[13px] py-[10px]">
              <div className="font-mono text-[11.5px] font-bold text-text">▦ {s.name}</div>
              <div className="mt-1 font-mono text-[9.5px] text-dim2">{s.spec}</div>
            </div>
          ))}

          {repos.map((r) => (
            <Fragment key={r.name}>
              <Link
                to={`/repos/${encodeURIComponent(r.name)}`}
                className="flex flex-col gap-1 border-b border-r border-line bg-panel px-[13px] py-[12px] text-left transition-colors hover:bg-panel2"
              >
                <span className="font-mono text-[12.5px] font-semibold text-text">{r.name}</span>
                <span className="font-mono text-[9.5px] text-dim2">{activeInRepo(r.name)} active&nbsp;&nbsp;↗</span>
              </Link>
              {ships.map((s) => (
                <div
                  key={s.name}
                  className="flex min-h-[66px] flex-col gap-2 border-b border-r border-line bg-bg p-[9px]"
                >
                  {cellWorkspaces(r.name, s.name).map((w) => (
                    <WorkspaceNode key={w.name} ws={w} />
                  ))}
                  <button
                    type="button"
                    onClick={() => setCreating({ repoName: r.name, ship: s.name })}
                    aria-label={`New workspace for ${r.name} on ${s.name}`}
                    className="mt-auto rounded-[var(--node-radius)] border border-dashed border-line py-[5px] font-mono text-[11px] text-dim2 transition-colors hover:border-accent hover:text-text"
                  >
                    +
                  </button>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}

      {creating && (
        <CreateWorkspaceModal
          repoName={creating.repoName}
          ship={creating.ship}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}
