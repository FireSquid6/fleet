import type { EphemeralWorkspace } from "fleet-protocol";
import { cn } from "@/lib/utils";

export function ephemeralSummary(ephemeral: EphemeralWorkspace): string {
  const parts = [`issue #${ephemeral.issueNumber}`];
  parts.push(
    ephemeral.pullRequest
      ? `PR #${ephemeral.pullRequest.number} ${ephemeral.pullRequest.state}`
      : "no pull request yet",
  );
  if (ephemeral.cleanup === "blocked") {
    parts.push(`cleanup blocked: ${ephemeral.blockedReason ?? "reason unknown"}`);
  }
  return parts.join(" · ");
}

export function EphemeralBadge({
  ephemeral,
  className,
}: {
  ephemeral: EphemeralWorkspace;
  className?: string;
}) {
  const blocked = ephemeral.cleanup === "blocked";
  return (
    <span
      title={`ephemeral · ${ephemeralSummary(ephemeral)}`}
      className={cn(
        "flex-none rounded-[3px] border px-[5px] py-[1px] text-[9px] font-semibold tracking-[.1em]",
        blocked ? "border-red-400/50 text-red-400" : "border-line text-dim2",
        className,
      )}
    >
      {blocked ? "⚠ EPHEMERAL" : "⧗ EPHEMERAL"}
    </span>
  );
}

export function EphemeralNote({ ephemeral }: { ephemeral: EphemeralWorkspace }) {
  const blocked = ephemeral.cleanup === "blocked";
  return (
    <span
      className={cn("flex flex-wrap items-center gap-[6px] font-mono text-[11px]", blocked ? "text-red-400" : "text-dim")}
    >
      <EphemeralBadge ephemeral={ephemeral} />
      {ephemeral.pullRequest ? (
        <a
          href={ephemeral.pullRequest.url}
          target="_blank"
          rel="noreferrer"
          className="transition-colors hover:text-text"
        >
          issue #{ephemeral.issueNumber} · PR #{ephemeral.pullRequest.number} {ephemeral.pullRequest.state} ↗
        </a>
      ) : (
        <span>
          issue #{ephemeral.issueNumber} · no pull request yet
        </span>
      )}
      {blocked && <span>cleanup blocked: {ephemeral.blockedReason ?? "reason unknown"}</span>}
    </span>
  );
}
