---
title: Workspaces
description: What a workspace is and how it moves through its lifecycle.
sidebar:
  order: 2
---

A workspace is a full git clone of one repo, on one branch, in its own
directory, with at most one agent working in it. It is the unit Fleet hands to
an agent, and it is deliberately not a worktree or a shared checkout — an agent
can `git pull`, rebase, thrash the index, and break the build without touching
anyone else's work.

## Identity and layout

Workspaces live under the ship's fleet directory:

```
<fleetDirectory>/
├── atlas.json              ← how an agent finds the ship
├── api-gateway/            ← repo name
│   ├── fix-auth/           ← workspace name (a clone)
│   └── bump-deps/
└── billing/
    └── retry-logic/
```

A workspace is identified by the `(repoName, name)` pair. Names are unique
within a repo; the pair `<repo>/<name>` is unique across a ship, and the
[bridge](/concepts/bridge/) extends that guarantee across the whole fleet.

The repo name is not derived from the clone URL. It is a name registered with
the bridge, and it doubles as the directory the clone lands under. See
[Managing repos](/guides/managing-repos/).

Both components are *fleet identifiers*: at most 128 UTF-8 bytes, not `.` or
`..`, no `/` or `\`, no Unicode control characters, well-formed Unicode. The
rules exist because these strings become directory names.

### Containment

Every path the ship builds from user input is resolved against the fleet
directory and checked to be a strict descendant of it. On top of that, the ship
refuses to follow symlinks when it opens an existing repo or workspace
directory, and re-checks the *canonical* (realpath-resolved) path is still
inside the fleet directory. A path that escapes is a `400`, not a traversal.

## States

A workspace has exactly two states, and neither of them is stored anywhere:

| State | Means |
|---|---|
| `inactive` | the directory exists; no tmux session |
| `active` | a tmux session is up for this workspace |

`active` is answered by asking tmux whether the workspace's session exists. The
session name is derived deterministically from `(repoName, name)` — see
[Terminals](/concepts/terminals/). There is no state file to get out of sync
with reality; if you kill the tmux server, every workspace is inactive.

Likewise, the workspace list is a directory scan. A directory only counts as a
workspace if its name is a valid identifier, it is a real directory (not a
symlink) inside the fleet directory, and it contains a `.git` **directory**.
Anything else on disk is quietly skipped, including entries that are replaced
mid-scan.

## Lifecycle

```
  create ──▶ inactive ──activate──▶ active ──deactivate──▶ inactive
              │                       │                      │
              └───────────────────────┴──────remove──────────┴──▶ gone
```

**Create** clones the repo into `<fleetDirectory>/<repo>/<name>` at the
requested branch. If the destination already exists the request fails with
`409`; the ship never clones over an existing directory. A new workspace starts
`inactive`.

**Activate** starts a headless tmux session rooted at the workspace directory.
Activating an already-active workspace is a `400`.

**Deactivate** kills that session and drops the agent status attached to it.

**Switch branch** runs a `git switch`, creating the branch if it doesn't exist.
It works in either state.

**Remove** kills the session if one is up, then deletes the directory
recursively. The `workspace.removed` event still reports the branch, captured
before the delete, so consumers can identify what went away.

Each of those emits an event on `/events` — see [Events](/concepts/events/).

## What a workspace reports

The list view (`GET /workspaces`) returns a summary per workspace: `repoName`,
`name`, `branch`, `active`, and `agent`. This same shape is what the event
stream carries.

The detail view (`GET /workspaces/:repo/:name`) is a discriminated union on
`state`. The `inactive` variant carries only the identity and branch. The
`active` variant adds the ship's name, the live agent status, and the diff
summary.

### The diff summary

The diff summary on an active workspace is three numbers:

| Field | Source |
|---|---|
| `added` | lines added, summed from `git diff --numstat HEAD` |
| `removed` | lines removed, same source |
| `commits` | commits ahead of the upstream branch, `0` when there is no upstream |

`--numstat HEAD` compares the working tree *and* the index against the last
commit, so staged and unstaged changes are both counted. Binary files report `-`
for both counts and are skipped rather than counted as zero.

It is computed on demand, per request. The bridge therefore proxies
`GET /workspaces/:repo/:name` straight through to the owning ship instead of
answering from its cached view — that request is the only way to get a fresh
diff.

For the actual patch there is `GET /workspaces/:repo/:name/diff`, which returns
raw `git diff` text and takes the usual narrowing options (`staged`, `stat`,
`nameOnly`, `range`, `paths`, `includeUntracked`). Unlike the summary it runs on
the on-disk tree regardless of state, so you can read an inactive workspace's
changes without starting a session.

:::note
`includeUntracked` synthesizes add-file diffs from `git ls-files --others`,
because `git diff` never reports untracked files. The web GUI's diff view uses
it, so brand-new files an agent created still show up.
:::

## Agents in a workspace

An agent attaches itself to an *active* workspace and reports what it's doing.
That status — state, description, model, provider, harness — is held in memory
on the ship, keyed by the workspace, and cleared when the session is
deactivated or removed. It is not persisted; a ship restart forgets it.

See [Agents](/concepts/agents/) for the contract, and
[Managing workspaces](/guides/managing-workspaces/) for the commands.
