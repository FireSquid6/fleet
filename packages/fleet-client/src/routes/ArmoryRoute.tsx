/**
 * ArmoryRoute — a read-only view of the bridge's armory: the files it hands out,
 * the map that says where dotfiles land, and how far each ship has got applying
 * them.
 *
 * The armory is edited on the bridge host, not here, so this page has no
 * mutations of any kind. It is also the only page that fetches its own data —
 * the armory is deliberately absent from the boot snapshot, since most sessions
 * never open it.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";
import type { ArmoryEntry, ArmoryFile, ArmoryManifest, ArmoryShipState } from "@/data/types";
import {
  abbreviateRevision,
  formatBytes,
  formatTimestamp,
  SECTION_ORDER,
  stripSection,
  syncStatus,
  type ArmorySyncStatus,
} from "@/lib/armory";
import { RowLabel } from "./ReposRoute";

const SHIP_COLS = "1fr 140px 1.4fr 130px";
const FILE_COLS = "1fr 90px 70px";

const STATUS_DOT: Record<ArmorySyncStatus, string> = {
  "in sync": "bg-accent",
  behind: "bg-status-awaiting",
  "never synced": "bg-dim2",
  error: "bg-red-400",
  unknown: "bg-dim2",
};

export function ArmoryRoute() {
  const { getArmory, getArmoryFile, listArmoryShips } = useFleet();
  const [manifest, setManifest] = useState<ArmoryManifest | null>(null);
  const [ships, setShips] = useState<ArmoryShipState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<ArmoryFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [loadedManifest, loadedShips] = await Promise.all([getArmory(), listArmoryShips()]);
        if (cancelled) return;
        setManifest(loadedManifest);
        setShips(loadedShips);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getArmory, listArmoryShips]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setFile(null);
    setFileError(null);
    setFileLoading(true);
    void (async () => {
      try {
        const loaded = await getArmoryFile(selected);
        if (!cancelled) setFile(loaded);
      } catch (e) {
        // Scoped to the viewer: a file that will not load must not take the
        // manifest and the ship table down with it.
        if (!cancelled) setFileError((e as Error).message);
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getArmoryFile, selected]);

  const grouped = useMemo(() => {
    const entries = manifest?.entries ?? [];
    return SECTION_ORDER.map((section) => ({
      section,
      entries: entries.filter((e) => e.section === section),
    })).filter((group) => group.entries.length > 0);
  }, [manifest]);

  const dotfiles = Object.entries(manifest?.dotfileMap ?? {});

  return (
    <div className="px-4 pb-16 pt-5 sm:px-[30px] sm:pb-[60px] sm:pt-[28px]">
      <Link to="/" className="font-mono text-[11px] font-medium text-dim transition-colors hover:text-text">
        ← bridge
      </Link>

      <div className="mb-[22px] mt-[14px] flex flex-wrap items-start justify-between gap-[18px]">
        <div>
          <h1 className="font-mono text-[22px] font-bold text-text">▤ Armory</h1>
          <p className="mt-2 max-w-2xl font-prose text-[12.5px] text-dim">
            Skills, plugins and dotfiles edited (or git-synced) in the bridge's data directory and distributed
            to every ship. This page only reads them — change them on the bridge host.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[9px] font-semibold tracking-[.14em] text-dim2">REVISION</span>
          <span className="font-mono text-[12px] text-text">
            {manifest ? abbreviateRevision(manifest.revision) : "—"}
          </span>
        </div>
      </div>

      {loading && <p className="font-mono text-[12px] text-dim">loading armory…</p>}
      {error && <p className="font-mono text-[12px] text-red-400">{error}</p>}

      {manifest && (
        <div className="flex flex-col gap-[26px]">
          <ShipSyncTable ships={ships} revision={manifest.revision} />

          <Section title="FILES">
            {grouped.length === 0 && (
              <div className="px-4 py-[18px] font-mono text-[11px] text-dim2">
                No armory files. Add them under <span className="text-dim">armory/</span> in the bridge's data
                directory.
              </div>
            )}
            {grouped.map((group, index) => (
              <div key={group.section}>
                <div
                  className={cn(
                    "hidden gap-3 bg-bg px-4 py-[10px] font-mono text-[9px] font-semibold tracking-[.14em] text-dim2 md:grid",
                    index > 0 && "border-t border-line",
                  )}
                  style={{ gridTemplateColumns: FILE_COLS }}
                >
                  <span>{group.section.toUpperCase()}</span>
                  <span className="text-right">SIZE</span>
                  <span className="text-right">MODE</span>
                </div>
                <div
                  className={cn(
                    "bg-bg px-4 py-[10px] font-mono text-[9px] font-semibold tracking-[.14em] text-dim2 md:hidden",
                    index > 0 && "border-t border-line",
                  )}
                >
                  {group.section.toUpperCase()}
                </div>
                {group.entries.map((entry) => (
                  <FileRow
                    key={entry.path}
                    entry={entry}
                    selected={entry.path === selected}
                    onSelect={() => setSelected(entry.path)}
                  />
                ))}
              </div>
            ))}
          </Section>

          {selected && (
            <FileViewer path={selected} file={file} loading={fileLoading} error={fileError} />
          )}

          <Section title="DOTFILE MAP">
            {dotfiles.length === 0 ? (
              <div className="px-4 py-[18px] font-mono text-[11px] text-dim2">
                No dotfile map — nothing under <span className="text-dim">dotfiles/</span> is linked into a
                ship's home directory.
              </div>
            ) : (
              dotfiles.map(([source, destination]) => (
                <div
                  key={source}
                  className="flex flex-col gap-1 border-t border-line px-4 py-[11px] font-mono md:grid md:grid-cols-2 md:items-center md:gap-3"
                >
                  <span className="break-all text-[11.5px] text-text">
                    <RowLabel>SOURCE</RowLabel>
                    dotfiles/{source}
                  </span>
                  <span className="break-all text-[11.5px] text-dim">
                    <RowLabel>DESTINATION</RowLabel>
                    {destination}
                  </span>
                </div>
              ))
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-[10px] font-mono text-[9.5px] font-semibold tracking-[.18em] text-dim2">{title}</h2>
      <div className="overflow-hidden rounded-md border border-line bg-panel">{children}</div>
    </section>
  );
}

function ShipSyncTable({ ships, revision }: { ships: ArmoryShipState[]; revision: string }) {
  return (
    <Section title="SHIPS">
      <div
        className="hidden gap-3 bg-bg px-4 py-[10px] font-mono text-[9px] font-semibold tracking-[.14em] text-dim2 md:grid"
        style={{ gridTemplateColumns: SHIP_COLS }}
      >
        <span>SHIP</span>
        <span>REVISION</span>
        <span>SYNCED</span>
        <span className="text-right">STATUS</span>
      </div>

      {ships.length === 0 && (
        <div className="border-t border-line px-4 py-[18px] font-mono text-[11px] text-dim2">
          No ships registered yet.
        </div>
      )}

      {ships.map((row) => {
        const status = syncStatus(revision, row.state);
        const install = row.state?.install;
        return (
          <div key={row.ship} className="border-t border-line px-4 py-[13px]">
            <div
              className="flex flex-col gap-1.5 font-mono md:grid md:items-center md:gap-3"
              style={{ gridTemplateColumns: SHIP_COLS }}
            >
              <span className="text-[12px] font-semibold text-text">▦ {row.ship}</span>
              <span className="text-[11px] text-dim">
                <RowLabel>REVISION</RowLabel>
                {abbreviateRevision(row.state?.revision ?? null)}
              </span>
              <span className="text-[11px] text-dim">
                <RowLabel>SYNCED</RowLabel>
                {formatTimestamp(row.state?.syncedAt ?? null)}
              </span>
              <span className="flex items-center gap-[7px] text-[10.5px] font-medium text-dim md:justify-end">
                <RowLabel>STATUS</RowLabel>
                <span className={cn("h-1.5 w-1.5 flex-none rounded-full", STATUS_DOT[status])} />
                {status}
              </span>
            </div>

            {install && (
              <div className="mt-2 font-mono text-[10.5px] text-dim2">
                {install.skillCount} skill files · {install.pluginCount} plugin files · {install.dotfileCount}{" "}
                dotfiles · {install.removedCount} removed · installed {formatTimestamp(install.installedAt)}
              </div>
            )}
            {row.state?.lastError && (
              <p className="mt-2 break-words font-mono text-[11px] text-red-400">{row.state.lastError}</p>
            )}
            {install?.conflicts.map((conflict) => (
              <p key={conflict} className="mt-1 break-all font-mono text-[11px] text-status-awaiting">
                conflict: {conflict}
              </p>
            ))}
            {install?.warnings.map((warning) => (
              <p key={warning} className="mt-1 break-words font-mono text-[11px] text-dim">
                warning: {warning}
              </p>
            ))}
          </div>
        );
      })}
    </Section>
  );
}

function FileRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ArmoryEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full flex-col gap-1 border-t border-line px-4 py-[11px] text-left font-mono transition-colors hover:bg-panel2 md:grid md:items-center md:gap-3",
        selected && "bg-accent-soft",
      )}
      style={{ gridTemplateColumns: FILE_COLS }}
    >
      <span className="min-w-0 break-all text-[11.5px] text-text">{stripSection(entry.path, entry.section)}</span>
      <span className="text-[10.5px] text-dim2 md:text-right">
        <RowLabel>SIZE</RowLabel>
        {formatBytes(entry.size)}
      </span>
      <span className="text-[10.5px] text-dim2 md:text-right">
        <RowLabel>MODE</RowLabel>
        {entry.mode === 0o755 ? "exec" : "—"}
      </span>
    </button>
  );
}

function FileViewer({
  path,
  file,
  loading,
  error,
}: {
  path: string;
  file: ArmoryFile | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <Section title="VIEWER">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-bg px-4 py-[10px]">
        <span className="break-all font-mono text-[11.5px] font-semibold text-text">{path}</span>
        {file && (
          <span className="font-mono text-[10px] text-dim2">
            {formatBytes(file.size)} · {file.encoding} · sha256 {abbreviateRevision(file.sha256)}
          </span>
        )}
      </div>

      {loading && <p className="border-t border-line px-4 py-[18px] font-mono text-[11px] text-dim">loading…</p>}
      {error && <p className="border-t border-line px-4 py-[18px] font-mono text-[11px] text-red-400">{error}</p>}

      {file &&
        (file.encoding === "base64" ? (
          <div className="border-t border-line px-4 py-[18px] font-mono text-[11px] text-dim">
            binary file, {formatBytes(file.size)} — not shown.
            <div className="mt-1 break-all text-[10.5px] text-dim2">sha256 {file.sha256}</div>
          </div>
        ) : (
          <pre className="max-h-[460px] overflow-auto border-t border-line px-4 py-[14px] font-mono text-[11.5px] leading-[1.6] text-text">
            {file.contents}
          </pre>
        ))}
    </Section>
  );
}
