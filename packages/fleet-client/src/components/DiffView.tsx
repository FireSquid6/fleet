import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRefs } from "fleet-protocol";
import { cn } from "@/lib/utils";
import { useFleet } from "@/data/FleetContext";
import { parseDiff, type DiffFile, type FileStatus } from "@/lib/diff/parse-diff";
import {
  clampCommitCount,
  DEFAULT_COMMIT_COUNT,
  describeDiffTarget,
  diffQuery,
  MAX_COMMIT_COUNT,
  type DiffTarget,
} from "@/lib/diff/diff-target";

interface DiffViewProps {
  repo: string;
  name: string;
}

type DiffMode = DiffTarget["kind"];

const MODE_LABELS: Record<DiffMode, string> = {
  working: "working tree",
  branch: "vs branch",
  commits: "last commits",
};

const STATUS_META: Record<FileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "bg-[#1a3a1f] text-[#3fb950]", label: "added" },
  modified: { letter: "M", className: "bg-[#1a2a3a] text-[#58a6ff]", label: "modified" },
  deleted: { letter: "D", className: "bg-[#3a1a1a] text-[#f85149]", label: "deleted" },
  renamed: { letter: "R", className: "bg-[#2a2a3a] text-[#a371f7]", label: "renamed" },
};

export function DiffView({ repo, name }: DiffViewProps) {
  const { getWorkspaceDiff, getWorkspaceRefs } = useFleet();
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [refs, setRefs] = useState<WorkspaceRefs | null>(null);

  const [mode, setMode] = useState<DiffMode>("working");
  // Null until the user picks one, so the branch target follows the repo's
  // default branch as soon as refs land.
  const [base, setBase] = useState<string | null>(null);
  const [includeWorking, setIncludeWorking] = useState(true);
  const [count, setCount] = useState(DEFAULT_COMMIT_COUNT);

  useEffect(() => {
    let cancelled = false;
    setRefs(null);
    void (async () => {
      try {
        const loaded = await getWorkspaceRefs(repo, name);
        if (!cancelled) setRefs(loaded);
      } catch {
        // Refs only feed the pickers; the diff itself still works without them.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getWorkspaceRefs, repo, name]);

  const branches = (refs?.branches ?? []).filter((b) => b.name !== refs?.current);
  const resolvedBase = base ?? refs?.defaultBranch ?? branches[0]?.name ?? "main";
  const maxCount = Math.min(MAX_COMMIT_COUNT, refs?.commits.length ?? MAX_COMMIT_COUNT) || 1;

  // A branch shallower than the requested depth has no `HEAD~N`, so the count is
  // held to what history actually exists once refs arrive.
  const effectiveCount = Math.min(count, maxCount);

  const target = useMemo<DiffTarget>(() => {
    if (mode === "branch") return { kind: "branch", base: resolvedBase, includeWorking };
    if (mode === "commits") return { kind: "commits", count: effectiveCount };
    return { kind: "working" };
  }, [mode, resolvedBase, includeWorking, effectiveCount]);

  const query = useMemo(() => diffQuery(target), [target]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const raw = await getWorkspaceDiff(repo, name, query);
        if (cancelled) return;
        const parsed = parseDiff(raw);
        setFiles(parsed);
        setSelectedId((prev) => (parsed.some((f) => f.id === prev) ? prev : (parsed[0]?.id ?? null)));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getWorkspaceDiff, repo, name, query, reloadKey]);

  const selected = files.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-term-bg">
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-term-line bg-term-chrome px-[14px] py-[8px]">
        <div className="flex items-center gap-[3px] rounded-[4px] border border-line p-[2px]">
          {(Object.keys(MODE_LABELS) as DiffMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded-[3px] px-[8px] py-[2px] font-mono text-[10px] font-semibold transition-colors",
                mode === m ? "bg-accent-soft text-text" : "text-dim hover:text-text",
              )}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {mode === "branch" && (
          <div className="flex items-center gap-2">
            <select
              value={resolvedBase}
              onChange={(e) => setBase(e.target.value)}
              className="rounded-[4px] border border-line bg-term-bg px-[7px] py-[3px] font-mono text-[10px] text-text"
              aria-label="Branch to compare against"
            >
              {branches.some((b) => b.name === resolvedBase) ? null : (
                <option value={resolvedBase}>{resolvedBase}</option>
              )}
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            <Toggle on={includeWorking} onClick={() => setIncludeWorking((v) => !v)}>
              + uncommitted
            </Toggle>
          </div>
        )}

        {mode === "commits" && (
          <div className="flex items-center gap-[6px]">
            <Step
              onClick={() => setCount(clampCommitCount(effectiveCount - 1))}
              disabled={effectiveCount <= 1}
              label="−"
              hint="Fewer commits"
            />
            <span className="font-mono text-[10.5px] tabular-nums text-text">
              {effectiveCount} commit{effectiveCount === 1 ? "" : "s"}
            </span>
            <Step
              onClick={() => setCount(Math.min(maxCount, clampCommitCount(effectiveCount + 1)))}
              disabled={effectiveCount >= maxCount}
              label="+"
              hint="More commits"
            />
          </div>
        )}

        <span className="ml-auto font-mono text-[10.5px] font-medium text-[#8b949e]">
          {files.length} {files.length === 1 ? "file" : "files"} · {describeDiffTarget(target)}
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-[4px] border border-line px-[10px] py-[3px] font-mono text-[10px] font-semibold text-dim transition-colors hover:text-text"
        >
          ↻ refresh
        </button>
      </div>

      {loading ? (
        <Centered>loading diff…</Centered>
      ) : error ? (
        <Centered className="text-term-err">{error}</Centered>
      ) : files.length === 0 ? (
        <Centered>No changes to show.</Centered>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex-none w-[240px] overflow-y-auto border-r border-term-line bg-term-bg">
            <ul className="py-1">
              {files.map((file) => {
                const meta = STATUS_META[file.status];
                const current = file.id === selectedId;
                return (
                  <li key={file.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(file.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-[12px] py-[6px] text-left font-mono transition-colors",
                        current ? "bg-accent-soft" : "hover:bg-term-chrome",
                      )}
                    >
                      <span
                        className={cn(
                          "flex-none rounded-[3px] px-[5px] py-[1px] text-[9px] font-bold",
                          meta.className,
                        )}
                        title={meta.label}
                      >
                        {meta.letter}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-text" title={file.path}>
                        {file.path}
                      </span>
                      <span className="flex-none text-[9.5px] tabular-nums">
                        <span className="text-[#3fb950]">+{file.additions}</span>{" "}
                        <span className="text-[#f85149]">−{file.deletions}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-term-bg">
            {selected ? <FilePatch file={selected} /> : null}
          </main>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-[4px] border px-[8px] py-[3px] font-mono text-[10px] font-semibold transition-colors",
        on ? "border-accent bg-accent-soft text-text" : "border-line text-dim hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

function Step({
  onClick,
  disabled,
  label,
  hint,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={hint}
      className="rounded-[4px] border border-line px-[7px] py-[2px] font-mono text-[11px] font-semibold text-dim transition-colors hover:text-text disabled:opacity-40 disabled:hover:text-dim"
    >
      {label}
    </button>
  );
}

function FilePatch({ file }: { file: DiffFile }) {
  const meta = STATUS_META[file.status];
  return (
    <div className="min-w-max">
      <div className="sticky top-0 flex items-center gap-[10px] border-b border-term-line bg-term-chrome px-[14px] py-[8px]">
        <span className={cn("rounded-[3px] px-[6px] py-[1px] font-mono text-[9px] font-bold", meta.className)}>
          {meta.label}
        </span>
        <span className="font-mono text-[11.5px] text-text">{file.path}</span>
        <span className="font-mono text-[10px]">
          <span className="text-[#3fb950]">+{file.additions}</span>{" "}
          <span className="text-[#f85149]">−{file.deletions}</span>
        </span>
      </div>

      {file.binary ? (
        <div className="px-[14px] py-[12px] font-mono text-[11px] text-dim">Binary file not shown.</div>
      ) : (
        <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.45]">
          <tbody>
            {file.hunks.map((hunk, hi) => (
              <HunkRows key={hi} header={hunk.header} lines={hunk.lines} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HunkRows({ header, lines }: { header: string; lines: DiffFile["hunks"][number]["lines"] }) {
  return (
    <>
      <tr className="bg-term-chrome/60">
        <td className="select-none border-r border-term-line px-[10px] text-right text-[#4d5560]" />
        <td className="select-none border-r border-term-line px-[10px] text-right text-[#4d5560]" />
        <td className="whitespace-pre px-[10px] text-[#58a6ff]">{header}</td>
      </tr>
      {lines.map((line, li) => {
        const rowClass =
          line.kind === "add"
            ? "bg-[#12261a] text-[#aff5b4]"
            : line.kind === "del"
              ? "bg-[#2a1517] text-[#ffdcd7]"
              : line.kind === "meta"
                ? "text-[#4d5560] italic"
                : "text-[#8b949e]";
        const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "meta" ? "" : " ";
        return (
          <tr key={li} className={rowClass}>
            <td className="w-px select-none whitespace-nowrap border-r border-term-line px-[10px] text-right text-[#4d5560]">
              {line.oldLine ?? ""}
            </td>
            <td className="w-px select-none whitespace-nowrap border-r border-term-line px-[10px] text-right text-[#4d5560]">
              {line.newLine ?? ""}
            </td>
            <td className="whitespace-pre px-[10px]">
              <span className="select-none text-[#4d5560]">{sign}</span>
              {line.content}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-1 items-center justify-center font-mono text-[12px] text-dim", className)}>
      {children}
    </div>
  );
}
