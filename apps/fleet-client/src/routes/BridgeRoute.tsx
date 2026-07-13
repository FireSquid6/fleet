import { Fragment } from "react";
import { Link } from "react-router-dom";
import { useFleet } from "@/data/FleetContext";
import { WorkspaceNode } from "@/components/WorkspaceNode";

export function BridgeRoute() {
  const { ships, repos, workspaces } = useFleet();

  const totalWs = workspaces.length;
  const activeWs = workspaces.filter((w) => w.active).length;
  const activeInRepo = (repo: string) => workspaces.filter((w) => w.repoName === repo && w.active).length;
  const cellWorkspaces = (repo: string, ship: string) =>
    workspaces.filter((w) => w.repoName === repo && w.ship === ship);

  return (
    <div className="px-[30px] pb-[60px] pt-[28px]">
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-[21px] font-bold tracking-[.01em] text-text">Bridge</h1>
          <p className="mt-[7px] max-w-[540px] font-prose text-[12.5px] leading-[1.5] text-dim">
            Every workspace across all repos and ships. Rows are repos, columns are ships (hosts). Open a repo
            header or a workspace node.
          </p>
        </div>
        <div className="whitespace-nowrap font-mono text-[12px] text-dim">
          <span className="text-[15px] font-bold text-accent">{activeWs}</span> / {totalWs} sessions active
        </div>
      </div>

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
              to={`/repos/${r.name}`}
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
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
