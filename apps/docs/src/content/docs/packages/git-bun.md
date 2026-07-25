---
title: git-bun
description: A typed, directory-bound wrapper around the git CLI for Bun.
sidebar:
  order: 2
---

`git-bun` drives git programmatically by wrapping the git CLI in a typed,
object-oriented API. Every `Git` instance is bound to a working directory at
construction and confined to it, which is the mechanism that lets a fleet of
agents each work in an isolated clone without ever touching each other's.

It is deliberately non-interactive: there is no `rebase -i`, no editor-driven
commit (`commit` always passes `-m`), and no credential prompting. Every
operation is a one-shot CLI invocation whose output is captured and parsed.

```ts
import { Git } from "git-bun";

const repo = new Git({ cwd: "/srv/app" });

await repo.add(".");
const sha = await repo.commit("wire up the thing");
const status = await repo.status();
console.log(status.branch, status.clean, status.files.length);
```

## Binding to a working directory

The constructor takes a `GitOptions` (an alias for `GitCommandOptions`) and an
optional backend:

```ts
new Git(options: GitOptions, backend?: GitBackend)
```

| Option | Type | Meaning |
| --- | --- | --- |
| `cwd` | `string` | Working directory, injected as `-C <cwd>` on every invocation. Must already exist. |
| `binary` | `string?` | git executable name/path. Defaults to `"git"`. |
| `env` | `Record<string, string>?` | Extra environment variables merged over the inherited process environment for every invocation. |

The bound directory is readable as `repo.cwd`.

Confinement is a hard guarantee rather than a convention. A single command
helper prepends `-C <cwd>` to every invocation, and no higher-level method ever
constructs that flag itself, so none of them can escape the directory:

```ts
const repo = new Git({ cwd: "/srv/app" });
// every call runs as: git -C /srv/app …
```

For commits that do not depend on the machine's git identity, pass `env`:

```ts
const repo = new Git({
  cwd: "/srv/app",
  env: {
    GIT_AUTHOR_NAME: "fleet",
    GIT_AUTHOR_EMAIL: "fleet@example.com",
    GIT_COMMITTER_NAME: "fleet",
    GIT_COMMITTER_EMAIL: "fleet@example.com",
  },
});
```

## Creating repositories

`init` and `clone` are static, because the directory they operate on does not
exist yet — `-C <dir>` would fail before the command ran. They scope their
creating command to `dirname(dir)` (which must already exist) and return a fresh
`Git` bound to the new directory.

| Method | Signature | Runs |
| --- | --- | --- |
| `Git.init` | `(dir: string, options?: InitOptions, backend?: GitBackend) => Promise<Git>` | `init [--bare] [-b <branch>] <basename>` |
| `Git.clone` | `(url: string, dir: string, options?: CloneOptions, backend?: GitBackend) => Promise<Git>` | `clone [--branch] [--depth] [--origin] [--bare] <url> <basename>` |

```ts
const fresh = await Git.init("/srv/new-repo", { initialBranch: "main" });
await Bun.write("/srv/new-repo/README.md", "# hi\n");
await fresh.add(".");
await fresh.commit("initial commit", { author: "Bot <bot@x.io>" });

const mirror = await Git.clone("https://github.com/org/repo.git", "/srv/repo", {
  branch: "main",
  depth: 1,
});
```

`InitOptions` accepts `bare`, `initialBranch`, `binary`, `env`. `CloneOptions`
accepts `branch`, `depth`, `origin`, `bare`, `binary`, `env`. In both cases
`binary`/`env` are carried over onto the returned handle.

## Staging and committing

| Method | Signature | Notes |
| --- | --- | --- |
| `add` | `(paths?: string \| string[], options?: AddOptions) => Promise<void>` | Defaults to `["."]`. `{ all: true }` uses `-A` and ignores `paths`. |
| `commit` | `(message: string, options?: CommitOptions) => Promise<string>` | Returns the new commit's hash (read back with `rev-parse HEAD`, since `commit`'s stdout is not machine-readable). |
| `reset` | `(options?: ResetOptions) => Promise<void>` | `{ mode, ref }` for a whole-tree reset; `{ paths, ref }` for a path-scoped one. The two forms are mutually exclusive. |
| `restore` | `(paths: string \| string[], options?: RestoreOptions) => Promise<void>` | `{ staged }` restores the index; `{ source }` maps to `--source <ref>`. |

```ts
await repo.add(["src/index.ts", "src/util.ts"]);
const sha = await repo.commit("fix the parser", { author: "Bot <bot@x.io>" });

await repo.reset({ mode: "hard", ref: "HEAD~1" });
await repo.restore(["src/index.ts"], { source: "HEAD" });
```

`CommitOptions` is `{ all?, allowEmpty?, amend?, author? }` mapping to `-a`,
`--allow-empty`, `--amend`, and `--author`. `ResetMode` is
`"soft" | "mixed" | "hard"`.

## Inspection

Every inspection method parses git's machine-readable output into a typed
struct. The format strings weave in ASCII Unit Separator (`0x1F`, exported as `FIELD_SEP`) as the field
separator, so splitting can never be fooled by a commit subject or a path.

| Method | Signature | Returns |
| --- | --- | --- |
| `isRepo` | `() => Promise<boolean>` | Whether `cwd` is inside a work tree. Never throws. |
| `toplevel` | `() => Promise<string>` | Absolute repository root. |
| `status` | `() => Promise<StatusInfo>` | Parsed from `status --porcelain=v2 -z --branch --untracked-files=all`. |
| `currentBranch` | `() => Promise<string>` | `branch --show-current`. Returns `""` when HEAD is detached. |
| `headSha` | `() => Promise<string>` | `rev-parse HEAD`. |
| `revParse` | `(ref: string) => Promise<string>` | Resolve any revision to a hash. |
| `log` | `(options?: LogOptions) => Promise<CommitInfo[]>` | Most recent first. |
| `diff` | `(options?: DiffOptions) => Promise<string>` | Raw diff text. |
| `show` | `(ref: string, options?: ShowOptions) => Promise<string>` | Raw `show` output; `{ stat: true }` for a diffstat. |

```ts
const status = await repo.status();
// { branch?, upstream?, ahead, behind, clean, files }
for (const file of status.files) {
  console.log(file.code, file.path, file.staged, file.origPath);
}

const history = await repo.log({ maxCount: 10, range: "main..feature" });
// CommitInfo: { sha, shortSha, authorName, authorEmail, authorDate, subject }

const patch = await repo.diff({ includeUntracked: true });
```

`FileStatus.code` is the two-character XY code from porcelain v2 — `"M."`
(staged modification), `".M"` (unstaged), `"A."`, `"UU"` for an unresolved
merge, or `"??"` for untracked. `authorDate` is Unix epoch seconds.

`DiffOptions.includeUntracked` is worth calling out: `git diff` never reports
untracked files, so this option lists them with `ls-files --others
--exclude-standard` and appends a synthesized `diff --no-index /dev/null <file>`
patch block for each. It is meant for full-patch output, not for `stat` or
`nameOnly`.

:::caution
`status()` throws on malformed porcelain v2 output rather than silently
returning a partial result — a missing trailing NUL, an invalid XY token, a bad
mode or object id all raise. That is deliberate: a half-parsed status is worse
than a loud failure.
:::

## Branches

| Method | Signature | Runs |
| --- | --- | --- |
| `branches` | `(options?: ListBranchesOptions) => Promise<BranchInfo[]>` | `branch --format=…`, plus `-a` (`{ all }`) or `-r` (`{ remote }`) |
| `createBranch` | `(name: string, options?: CreateBranchOptions) => Promise<void>` | `branch <name> [startPoint]` — creates without checking out |
| `checkout` | `(ref: string, options?: CheckoutOptions) => Promise<void>` | `checkout [-b] <ref>` |
| `switchBranch` | `(ref: string, options?: SwitchOptions) => Promise<void>` | `switch [-c] [--detach] <ref>` |
| `deleteBranch` | `(name: string, options?: DeleteBranchOptions) => Promise<void>` | `branch -d`, or `-D` with `{ force: true }` |

```ts
await repo.createBranch("feature", { startPoint: "main" });
await repo.switchBranch("feature");

for (const branch of await repo.branches({ all: true })) {
  console.log(branch.name, branch.sha, branch.current, branch.upstream);
}
```

`switchBranch` is the modern, less error-prone form; `checkout` is kept for
cases that need it.

## Remotes and sync

| Method | Signature | Options |
| --- | --- | --- |
| `fetch` | `(options?: FetchOptions) => Promise<void>` | `remote`, `prune`, `all` |
| `pull` | `(options?: PullOptions) => Promise<void>` | `rebase`, `remote`, `branch` |
| `push` | `(options?: PushOptions) => Promise<void>` | `remote`, `branch`, `setUpstream`, `force`, `tags` |
| `remotes` | `() => Promise<RemoteInfo[]>` | Parsed from `remote -v`, one entry per remote name |
| `addRemote` | `(name: string, url: string) => Promise<void>` | `remote add` |

```ts
await repo.addRemote("origin", "git@github.com:org/repo.git");
await repo.push({ remote: "origin", branch: "feature", setUpstream: true });
await repo.fetch({ all: true, prune: true });
```

`RemoteInfo` is `{ name, fetchUrl, pushUrl }` — the two URL lines git prints per
remote are folded into a single entry.

## Worktrees

A worktree is the isolation primitive: it gives a task its own working directory
on its own branch, backed by the same object store. `worktreeAdd` runs from the
current repo (so no parent-scoping is needed) and returns a handle already bound
to the new directory.

| Method | Signature | Runs |
| --- | --- | --- |
| `worktreeAdd` | `(path: string, options?: WorktreeAddOptions) => Promise<Git>` | `worktree add [--detach] [--force] [-b <newBranch>] <path> [commitish]` |
| `worktreeList` | `() => Promise<WorktreeInfo[]>` | `worktree list --porcelain`, including the main worktree |
| `worktreeRemove` | `(path: string, options?: WorktreeRemoveOptions) => Promise<void>` | `worktree remove [--force] <path>` |
| `worktreePrune` | `() => Promise<void>` | `worktree prune` |

```ts
const agent = await repo.worktreeAdd("/srv/agents/1", { newBranch: "agent/1" });
await agent.status();  // runs in /srv/agents/1, on branch agent/1

for (const wt of await repo.worktreeList()) {
  console.log(wt.path, wt.sha, wt.branch, wt.detached, wt.bare, wt.locked);
}

await repo.worktreeRemove("/srv/agents/1", { force: true });
```

The returned handle inherits the parent's `binary` and `env`, so a worktree
created by a handle with a deterministic identity keeps that identity.

## Config

```ts
await repo.setConfig("user.name", "CI");
const name = await repo.getConfig("user.name");        // string | undefined
const global = await repo.getConfig("user.email", { global: true });
```

| Method | Signature |
| --- | --- |
| `getConfig` | `(key: string, scope?: ConfigScope) => Promise<string \| undefined>` |
| `setConfig` | `(key: string, value: string, scope?: ConfigScope) => Promise<void>` |

`ConfigScope` is `{ global?: boolean }`, mapping to `--global`.

## Values, not exceptions

Existence probes return values; genuine failures throw. This is a deliberate
split:

- `isRepo()` returns `false` rather than throwing when `cwd` is not a work tree.
- `getConfig()` returns `undefined` for an unset key, mirroring git's own
  "exit 1, no output" convention. If git exits non-zero *with* stderr, that is a
  real failure and it throws.
- Everything else throws `GitError` on a non-zero exit.

```ts
import { GitError } from "git-bun";

try {
  await repo.commit("nothing to see here");
} catch (error) {
  if (error instanceof GitError) {
    console.error(error.args);      // readonly string[] — the argv, minus the binary
    console.error(error.exitCode);  // number
    console.error(error.stderr);    // string
    console.error(error.stdout);    // string
  }
}
```

`GitError.message` is formatted as
`git <args> failed (exit <code>): <stderr or stdout or "no output">`.

:::note
A handful of methods that translate an expected failure themselves throw a plain
`Error` rather than a `GitError` — `getConfig` when git fails for a reason other
than "unset", and `status`/`parseStatus` on malformed porcelain output. Catch
`Error` if you need to be exhaustive.
:::

## The low-level escape hatch

Every call in the library goes through one `GitCommand`, exposed as
`repo.command` for subcommands that are not wrapped. It is still `-C
<cwd>`-confined, so the directory guarantee holds:

```ts
const notes = await repo.command.run(["notes", "show", "HEAD"]);

// tryRun never throws — inspect the exit code yourself.
const res = await repo.command.tryRun(["merge-base", "--is-ancestor", "a", "b"]);
const isAncestor = res.exitCode === 0;
```

| Member | Signature | Behavior |
| --- | --- | --- |
| `command.cwd` | `string` | The bound directory. |
| `command.run` | `(args: readonly string[]) => Promise<string>` | Throws `GitError` on non-zero exit. Returns raw, untrimmed stdout. |
| `command.tryRun` | `(args: readonly string[]) => Promise<GitRunResult>` | Never throws. `{ stdout, stderr, exitCode }`. |

`run` returns stdout untrimmed on purpose, so callers reading diffs or file
content keep exact bytes; `.trim()` yourself when reading a single id or ref.

### Swapping the transport

`GitCommand` is also the single transport seam — the only place that spawns git.
Implement `GitBackend` to replace it:

```ts
import { Git, type GitBackend, type GitRunResult } from "git-bun";

const recording: GitBackend = {
  async run(args: readonly string[]): Promise<GitRunResult> {
    console.log("git", args.join(" "));
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

const repo = new Git({ cwd: "/srv/app" }, recording);
```

The `args` a backend receives already include the `-C <cwd>` flags, so a backend
must never inject its own. The default `ShellBackend` spawns one-shot processes
via `Bun.$`, which escapes each array element into a distinct argv entry — there
is no shell to inject into.

## Parsers and format strings

The pure output parsers are exported so they can be reused or tested without
git present:

```ts
import {
  FIELD_SEP,
  LOG_FORMAT,
  BRANCH_FORMAT,
  parseLog,
  parseStatus,
  parseBranches,
  parseWorktrees,
} from "git-bun";
```

`LOG_FORMAT` is `%H %h %an %ae %at %s` joined by `FIELD_SEP`; `BRANCH_FORMAT` is
`%(refname:short) %(objectname) %(HEAD) %(upstream:short)` joined the same way.

## Attaching by hand

Because the library never runs anything interactive, anything it cannot express
you run yourself in the directory a handle is bound to:

```bash
cd /srv/agents/1
git rebase -i main
```

## Testing

```bash
cd packages/git-bun
bun test
```

The parsers are unit-tested without git. The end-to-end suite creates throwaway
repositories in a temp directory — never your own repos — and the whole suite
skips gracefully when `git` is not on `PATH`.
