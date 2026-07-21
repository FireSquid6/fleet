// Typed structs parsed out of git plumbing/porcelain output, plus the options
// objects each Git method accepts. Field names favor the git concept they come
// from (e.g. `shortSha` from `%h`, `ahead`/`behind` from `branch.ab`).

/** A commit as reported by `git log` with a machine-readable `--pretty` format. */
export interface CommitInfo {
  /** Full 40-char commit hash (`%H`). Usable directly as a ref. */
  sha: string;
  /** Abbreviated commit hash (`%h`). */
  shortSha: string;
  /** Author name (`%an`). */
  authorName: string;
  /** Author email (`%ae`). */
  authorEmail: string;
  /** Author date as a Unix epoch (seconds, `%at`). */
  authorDate: number;
  /** Commit subject — the first line of the message (`%s`). */
  subject: string;
}

/** One changed, unmerged, or untracked path from `status --porcelain=v2`. */
export interface FileStatus {
  /** Path relative to the repository root. For renames, the destination path. */
  path: string;
  /**
   * Two-character XY status code, e.g. `"M."` (staged-modified), `".M"`
   * (unstaged-modified), `"A."` (staged-add), `"UU"` (unresolved), or `"??"`
   * for untracked. For ordinary entries, `X` is the staged/index state and `Y`
   * the worktree state; unresolved XY codes instead describe merge-stage states.
   */
  code: string;
  /** Whether `X` denotes a staged change. Always `false` for unmerged records. */
  staged: boolean;
  /** For a rename/copy entry, the original path; otherwise `undefined`. */
  origPath?: string;
}

/** Repository status as reported by `git status --porcelain=v2 --branch`. */
export interface StatusInfo {
  /** Current branch name, or `undefined` when detached. */
  branch?: string;
  /** Upstream branch (`branch.upstream`), or `undefined` when none is set. */
  upstream?: string;
  /** Commits ahead of the upstream. `0` when there is no upstream. */
  ahead: number;
  /** Commits behind the upstream. `0` when there is no upstream. */
  behind: number;
  /** Whether the working tree is clean (no staged, unstaged, unmerged, or untracked changes). */
  clean: boolean;
  /** Every changed, unmerged, or untracked path. */
  files: FileStatus[];
}

/** A worktree as reported by `git worktree list --porcelain`. */
export interface WorktreeInfo {
  /** Absolute path to the worktree's root directory. */
  path: string;
  /** Checked-out commit hash. Empty for a bare repository entry. */
  sha: string;
  /** Checked-out branch name (without `refs/heads/`), or `undefined` if detached/bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

/** A branch as reported by `git branch` with a machine-readable format. */
export interface BranchInfo {
  /** Short branch name, e.g. `"main"`. */
  name: string;
  /** Commit hash the branch points at. */
  sha: string;
  current: boolean;
  /** Upstream tracking branch (e.g. `"origin/main"`), or `undefined` if none. */
  upstream?: string;
}

/** A configured remote as reported by `git remote -v`. */
export interface RemoteInfo {
  /** Remote name, e.g. `"origin"`. */
  name: string;
  /** URL used for fetching. */
  fetchUrl: string;
  /** URL used for pushing (usually identical to {@link fetchUrl}). */
  pushUrl: string;
}

/** Mode passed to {@link Git.reset}: how far the reset reaches. */
export type ResetMode = "soft" | "mixed" | "hard";

/** Options for {@link Git.init}. */
export interface InitOptions {
  /** Create a bare repository (`--bare`). */
  bare?: boolean;
  /** Name of the initial branch (`-b`), e.g. `"main"`. */
  initialBranch?: string;
  /** git executable name/path. Defaults to `"git"`. */
  binary?: string;
  /** Extra environment variables for every invocation on the returned handle. */
  env?: Record<string, string>;
}

/** Options for {@link Git.clone}. */
export interface CloneOptions {
  /** Branch or tag to check out (`--branch`). */
  branch?: string;
  /** Create a shallow clone truncated to this many commits (`--depth`). */
  depth?: number;
  /** Name for the remote instead of `"origin"` (`--origin`). */
  origin?: string;
  /** Create a bare clone (`--bare`). */
  bare?: boolean;
  /** git executable name/path. Defaults to `"git"`. */
  binary?: string;
  /** Extra environment variables for every invocation on the returned handle. */
  env?: Record<string, string>;
}

/** Options for {@link Git.log}. */
export interface LogOptions {
  /** Limit to the most recent N commits (`-n`). */
  maxCount?: number;
  /** Commit or range to log, e.g. `"main"` or `"main..feature"`. Defaults to HEAD. */
  range?: string;
  /** Restrict history to commits touching these paths. */
  paths?: string[];
}

/** Options for {@link Git.diff}. */
export interface DiffOptions {
  /** Diff the index against HEAD (`--staged`) instead of the working tree. */
  staged?: boolean;
  /** Emit a diffstat summary (`--stat`) instead of the full patch. */
  stat?: boolean;
  /** List only changed paths (`--name-only`). */
  nameOnly?: boolean;
  /** Commit or range to diff, e.g. `"HEAD~1"` or `"main..feature"`. */
  range?: string;
  /** Restrict the diff to these paths. */
  paths?: string[];
  /**
   * Append synthesized add-file diffs for untracked files (`ls-files --others`),
   * which `git diff` never reports on its own. Intended for full-patch output.
   */
  includeUntracked?: boolean;
}

/** Options for {@link Git.show}. */
export interface ShowOptions {
  /** Emit a diffstat summary (`--stat`) instead of the full patch. */
  stat?: boolean;
}

/** Options for {@link Git.add}. */
export interface AddOptions {
  /** Stage all changes including deletions (`-A`), ignoring the `paths` argument. */
  all?: boolean;
}

/** Options for {@link Git.commit}. */
export interface CommitOptions {
  /** Automatically stage modified/deleted tracked files before committing (`-a`). */
  all?: boolean;
  /** Allow a commit that records no changes (`--allow-empty`). */
  allowEmpty?: boolean;
  /** Replace the tip commit instead of adding a new one (`--amend`). */
  amend?: boolean;
  /** Override the author (`--author "Name <email>"`). */
  author?: string;
}

/** Options for {@link Git.reset}. */
export interface ResetOptions {
  /** How far to reset: `"soft"`, `"mixed"` (default), or `"hard"`. */
  mode?: ResetMode;
  /** Commit to reset to. Defaults to HEAD. */
  ref?: string;
  /** Restrict a path-scoped reset to these paths (incompatible with `mode`). */
  paths?: string[];
}

/** Options for {@link Git.restore}. */
export interface RestoreOptions {
  /** Restore the index (`--staged`) rather than the working tree. */
  staged?: boolean;
  /** Source to restore from (`--source <ref>`), e.g. `"HEAD"`. */
  source?: string;
}

/** Options for {@link Git.branches}. */
export interface ListBranchesOptions {
  /** Include remote-tracking branches as well as local ones (`-a`). */
  all?: boolean;
  /** List only remote-tracking branches (`-r`). */
  remote?: boolean;
}

/** Options for {@link Git.createBranch}. */
export interface CreateBranchOptions {
  /** Commit/branch to start the new branch from. Defaults to HEAD. */
  startPoint?: string;
}

/** Options for {@link Git.checkout}. */
export interface CheckoutOptions {
  /** Create the branch before checking it out (`-b`). */
  create?: boolean;
}

/** Options for {@link Git.switchBranch}. */
export interface SwitchOptions {
  /** Create the branch before switching to it (`-c`). */
  create?: boolean;
  /** Detach HEAD at the given commit (`--detach`). */
  detach?: boolean;
}

/** Options for {@link Git.deleteBranch}. */
export interface DeleteBranchOptions {
  /** Force deletion of an unmerged branch (`-D` instead of `-d`). */
  force?: boolean;
}

/** Options for {@link Git.fetch}. */
export interface FetchOptions {
  /** Remote to fetch from. Defaults to git's default (usually `origin`). */
  remote?: string;
  /** Remove remote-tracking refs that no longer exist upstream (`--prune`). */
  prune?: boolean;
  /** Fetch from all remotes (`--all`). */
  all?: boolean;
}

/** Options for {@link Git.pull}. */
export interface PullOptions {
  /** Rebase local commits onto the fetched head instead of merging (`--rebase`). */
  rebase?: boolean;
  /** Remote to pull from. */
  remote?: string;
  /** Branch to pull. */
  branch?: string;
}

/** Options for {@link Git.push}. */
export interface PushOptions {
  /** Remote to push to. */
  remote?: string;
  /** Branch/refspec to push. */
  branch?: string;
  /** Set the pushed branch as upstream (`-u`). */
  setUpstream?: boolean;
  /** Force-push (`--force`). */
  force?: boolean;
  /** Also push tags (`--tags`). */
  tags?: boolean;
}

/** Options for {@link Git.worktreeAdd}. */
export interface WorktreeAddOptions {
  /** Create a new branch for the worktree (`-b <newBranch>`). */
  newBranch?: string;
  /** Check out with a detached HEAD (`--detach`). */
  detach?: boolean;
  /** Allow creation even when the path/branch checks would normally block it (`--force`). */
  force?: boolean;
  /** Commit/branch to base the worktree on (trailing argument). */
  commitish?: string;
}

/** Options for {@link Git.worktreeRemove}. */
export interface WorktreeRemoveOptions {
  /** Remove even with uncommitted changes or a locked worktree (`--force`). */
  force?: boolean;
}

/** Scope for {@link Git.getConfig} / {@link Git.setConfig}. */
export interface ConfigScope {
  /** Operate on the global (`--global`) config rather than the repository's. */
  global?: boolean;
}
