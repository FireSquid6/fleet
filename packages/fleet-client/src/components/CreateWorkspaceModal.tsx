import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useFleet } from "@/data/FleetContext";
import type { RepoBranch, RepoIssue } from "@/data/types";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, highlight, splitRanges } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { branchState, createWorkspaceInput, issueBranchPreview, issueText } from "@/lib/create-workspace";
import { Field, ModalActions } from "@/routes/ReposRoute";
import { useSubmitAction } from "@/lib/useSubmitAction";

// Module-level so the pickers' memoised filtering is not invalidated every render.
const branchName = (branch: RepoBranch) => branch.name;
const issueKey = (issue: RepoIssue) => String(issue.number);

interface Props {
  repoName: string;
  /** When set, the ship is fixed (Bridge cell entry); otherwise a dropdown is shown. */
  ship?: string;
  onClose: () => void;
}

/**
 * The create-workspace form. The branch can be picked two ways: by name, out of
 * the repo's remote branches (or typed, which creates it), or by open issue, in
 * which case the bridge derives and links the branch and the client only previews
 * the name it will pick.
 *
 * Both lists are allowed to be missing — `GET /repos/:name/branches` needs to
 * reach the remote and the issues route needs a provider and a token — so
 * neither is on the critical path: a repo whose branches cannot be listed falls
 * back to the plain text field this form used to be, and issues are not even
 * requested until the checkbox is ticked, since for a `custom` repo that request
 * is a guaranteed 501.
 */
export function CreateWorkspaceModal({ repoName, ship, onClose }: Props) {
  const { ships, createWorkspace, listRepoBranches, listRepoIssues } = useFleet();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const [selectedShip, setSelectedShip] = useState(ship ?? ships[0]?.name ?? "");

  // null while unknown — loading or failed. `branchState` reads it as "cannot say".
  const [branches, setBranches] = useState<RepoBranch[] | null>(null);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  const [fromIssue, setFromIssue] = useState(false);
  const [issues, setIssues] = useState<RepoIssue[]>([]);
  const [issuesLoaded, setIssuesLoaded] = useState(false);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issueQuery, setIssueQuery] = useState("");
  const [issue, setIssue] = useState<RepoIssue | null>(null);

  const shipName = ship ?? selectedShip;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await listRepoBranches(repoName);
        if (!cancelled) setBranches(loaded);
      } catch (e) {
        if (!cancelled) setBranchesError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listRepoBranches, repoName]);

  // Lazy on purpose: see the component's note about `custom` repos. A failed load
  // leaves `issuesLoaded` false, so unticking and re-ticking retries.
  useEffect(() => {
    if (!fromIssue || issuesLoaded) return;
    let cancelled = false;
    setIssuesLoading(true);
    setIssuesError(null);
    void (async () => {
      try {
        const loaded = await listRepoIssues(repoName);
        if (cancelled) return;
        setIssues(loaded);
        setIssuesLoaded(true);
      } catch (e) {
        if (!cancelled) setIssuesError((e as Error).message);
      } finally {
        if (!cancelled) setIssuesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromIssue, issuesLoaded, listRepoIssues, repoName]);

  const state = branchState(branch, branches);
  const input = createWorkspaceInput({ ship: shipName, repoName, name, fromIssue, branch, issue });

  const { error, pending, submit } = useSubmitAction(() => createWorkspace(input!), onClose);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // `input` being null is what disables the Create button, but implicit
    // submission can still reach here.
    if (input && !pending) void submit();
  };

  return (
    <Modal open title="New Workspace" onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Repo">
          <div className="font-mono text-[12px] text-text">▣ {repoName}</div>
        </Field>

        <Field label="Ship">
          {ship ? (
            <div className="font-mono text-[12px] text-text">▦ {ship}</div>
          ) : (
            <select
              value={selectedShip}
              onChange={(e) => setSelectedShip(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-[12px] text-text outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {ships.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="feature-x" autoFocus />
        </Field>

        <Checkbox checked={fromIssue} onChange={setFromIssue}>
          Create from issue
        </Checkbox>

        {fromIssue ? (
          <Field label="Issue">
            <Combobox
              value={issueQuery}
              onValueChange={(value) => {
                setIssueQuery(value);
                // Editing the text abandons the selection: what the field says and
                // what would be submitted must never disagree.
                setIssue(null);
              }}
              items={issues}
              toText={issueText}
              toKey={issueKey}
              renderItem={(i, ranges) => <IssueRow issue={i} ranges={ranges} />}
              onSelect={(i) => {
                setIssue(i);
                setIssueQuery(issueText(i));
              }}
              placeholder="Search open issues"
              disabled={issuesError !== null}
              // No message while the issues are still on their way: the list
              // would claim nothing matches over the "listing issues…" below it.
              emptyMessage={issuesLoading ? undefined : "No open issue matches."}
            />
            {issuesError ? (
              <Note className="text-red-400">Issues could not be listed: {issuesError}</Note>
            ) : issuesLoading ? (
              <Note className="text-dim2">listing issues…</Note>
            ) : issue ? (
              <SelectedIssue issue={issue} />
            ) : null}
          </Field>
        ) : (
          <Field label="Branch">
            <Combobox
              value={branch}
              onValueChange={setBranch}
              items={branches ?? []}
              toText={branchName}
              toKey={branchName}
              onSelect={(b) => setBranch(b.name)}
              placeholder="main"
              allowFreeText
            />
            {state.kind === "existing" && <Note className="text-dim">On branch {state.branch}</Note>}
            {state.kind === "new" && <Note className="text-accent">Creating new branch {state.branch}</Note>}
            {state.kind === "unknown" && (
              <Note className="text-dim2">
                {branchesError ? "Branches could not be listed — type a branch name." : "listing branches…"}
              </Note>
            )}
          </Field>
        )}

        {error && <p className="font-mono text-[11px] text-red-400">{error}</p>}
        <ModalActions onCancel={onClose} confirmLabel="Create" pending={pending} disabled={input === null} />
      </form>
    </Modal>
  );
}

/** One line of small mono text under a field. */
function Note({ children, className }: { children: ReactNode; className: string }) {
  return <span className={cn("font-mono text-[11px]", className)}>{children}</span>;
}

function IssueRow({ issue, ranges }: { issue: RepoIssue; ranges: [number, number][] }) {
  const text = issueText(issue);
  const pivot = `#${issue.number}`.length;
  const [numberRanges, titleRanges] = splitRanges(ranges, pivot);
  return (
    <span className="flex items-baseline gap-2">
      <span className="flex-none text-dim2">{highlight(text.slice(0, pivot), numberRanges)}</span>
      <span className="min-w-0 flex-1 truncate">{highlight(text.slice(pivot), titleRanges)}</span>
      {issue.author && <span className="flex-none text-[10px] text-dim2">@{issue.author}</span>}
    </span>
  );
}

function SelectedIssue({ issue }: { issue: RepoIssue }) {
  const preview = issueBranchPreview(issue);
  return (
    <span className="flex flex-col gap-0.5">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[11px] text-dim transition-colors hover:text-text"
      >
        {issueText(issue)} ↗
      </a>
      {preview && (
        <span className="font-mono text-[11px] text-accent">
          Creating new branch {preview}{" "}
          <span className="text-[10px] text-dim2">(the provider may adjust the name)</span>
        </span>
      )}
    </span>
  );
}
