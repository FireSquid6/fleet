---
title: fagent CLI reference
description: The agent-facing CLI — self-reporting from inside a workspace, plus repo, PR, and CI commands over the bridge.
sidebar:
  order: 6
---

`fagent` is the CLI an agent runs from *inside* a workspace. Unlike `fleet` —
which is for the human or process managing the fleet — `fagent` is agent-facing:
it auto-detects the current workspace and needs no workspace name or ship URL to
do its job. It mounts two command groups:

| Command | Purpose |
| --- | --- |
| `fagent agent` | Workspace self-reporting: register a session and report status. |
| `fagent repo` | Read and act on the workspace's repo — issues, PRs, reviews, CI — through the bridge. |

## `fagent agent`

Workspace self-reporting commands, meant to be run by an agent from inside a
workspace directory. They locate the ship by walking up from the current
directory to the nearest `atlas.json` and derive `(repo, name)` from the first
two path segments below it, then POST to `http://localhost:<port>`. Nothing here
uses `--url`.

Every command except `in-workspace` prints
`fagent: not inside a fleet workspace` and exits 1 when no workspace is found.

### `fagent agent init`

```bash
fagent agent init --model <model> --provider <provider> --harness <harness>
```

| Option | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--model` | `<model>` | yes | none | Model driving the agent, e.g. `claude-opus-4-8`. |
| `--provider` | `<provider>` | yes | none | Model provider, e.g. `anthropic`. |
| `--harness` | `<harness>` | yes | none | Agent harness, e.g. `claude-code`. |

Starts an agent session and seeds its status to `idle`. Prints
`agent session started on <repo>/<name> (<state>)`. Requires the workspace to be
active; otherwise the ship returns 400 and the CLI exits 1.

### `fagent agent status`

```bash
fagent agent status <state> -d <text>
```

| Argument | Meaning |
| --- | --- |
| `<state>` | One of `idle`, `planning`, `building`, `verifying`, `awaiting`. |

| Option | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `-d, --description` | `<text>` | yes | none | Short summary of what the agent is doing (100–200 characters). |

An invalid state prints
`fagent: invalid state "<state>"; expected one of: idle, planning, building, verifying, awaiting`
and exits 1 before any request is made. On success it prints
`status updated to <state> on <repo>/<name>`. `fagent agent init` must have run
first; otherwise the ship returns 400.

### `fagent agent in-workspace`

```bash
fagent agent in-workspace
```

Takes no arguments or options. Prints `<repo>/<name>` and exits 0 inside a
workspace; prints `no workspace` and exits 1 anywhere else.

## `fagent repo`

Repo-facing commands that read and act on the workspace's repository — its
issues, pull requests, reviews, and CI runs. They always flow through the fleet
**bridge**, never GitHub directly; the bridge holds the credentials and speaks
to the provider on the agent's behalf.

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `-r, --repo` | `<name>` | auto-detected from the workspace | Repo to act on, overriding auto-detection. |
| `--bridge-url` | `<url>` | `http://localhost:4800` | Base URL of the Fleet Bridge to talk to. |

By default `fagent repo` figures out which repo it is in the same way
`fagent agent` finds its workspace — by walking up to `atlas.json` — and passes
that repo name to the bridge. Use `-r, --repo` to target a different registered
repo.

### `fagent repo info`

```bash
fagent repo info
```

Prints the bridge's summary of the repository — its name, clone URL, and
provider.

### `fagent repo issue list`

```bash
fagent repo issue list [-s open|closed|all]
```

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `-s, --state` | `open` \| `closed` \| `all` | `open` | Which issues to list. |

Lists the repo's issues in the selected state.

### `fagent repo issue view`

```bash
fagent repo issue view <n>
```

| Argument | Meaning |
| --- | --- |
| `<n>` | Issue number. |

Prints the full issue: title, state, author, body, and metadata.

### `fagent repo issue comment`

```bash
fagent repo issue comment <n> <body>
```

| Argument | Meaning |
| --- | --- |
| `<n>` | Issue number. |
| `<body>` | Comment text. |

Posts a comment on the issue through the bridge.

### `fagent repo pr list`

```bash
fagent repo pr list [-s open|closed|all]
```

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `-s, --state` | `open` \| `closed` \| `all` | `open` | Which pull requests to list. |

Lists the repo's pull requests in the selected state.

### `fagent repo pr view`

```bash
fagent repo pr view <n>
```

| Argument | Meaning |
| --- | --- |
| `<n>` | Pull request number. |

Prints the full pull request: title, state, author, body, and metadata.

### `fagent repo pr comment`

```bash
fagent repo pr comment <n> <body>
```

| Argument | Meaning |
| --- | --- |
| `<n>` | Pull request number. |
| `<body>` | Comment text. |

Posts a comment on the pull request through the bridge.

### `fagent repo review`

```bash
fagent repo review <n> (--approve | --request-changes | --comment) [-b <body>]
```

| Argument | Meaning |
| --- | --- |
| `<n>` | Pull request number. |

| Option | Argument | Meaning |
| --- | --- | --- |
| `--approve` | — | Submit an approving review. |
| `--request-changes` | — | Submit a review requesting changes. |
| `--comment` | — | Submit a plain comment review. |
| `-b, --body` | `<body>` | Review body text. |

Submits a review on the pull request. Exactly one of `--approve`,
`--request-changes`, or `--comment` selects the review type.

### `fagent repo checks`

```bash
fagent repo checks [--pr <n> | --ref <ref>]
```

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--pr` | `<n>` | — | Report checks for the head of pull request `<n>`. |
| `--ref` | `<ref>` | — | Report checks for an explicit git ref. |

Lists the CI check runs and their conclusions. With neither `--pr` nor `--ref`
it defaults to the current git branch.

### `fagent repo logs`

```bash
fagent repo logs [--pr <n> | --ref <ref>]
```

| Option | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `--pr` | `<n>` | — | Fetch logs for the head of pull request `<n>`. |
| `--ref` | `<ref>` | — | Fetch logs for an explicit git ref. |

Returns the raw logs of the **failed** GitHub Actions jobs for the selected ref,
so an agent can read a broken CI run and fix it. As with `checks`, it defaults
to the current git branch when neither `--pr` nor `--ref` is given. Because it
reads GitHub Actions job logs specifically, it reports an error when a failing
check is not Actions-backed — there is no API log to fetch for those.

## Exit codes and error output

Like `fleet`, `fagent` exits non-zero on failure and prints a diagnostic prefixed
with `fagent:`.

| Situation | Output | Exit |
| --- | --- | --- |
| Not inside a fleet workspace | `fagent: not inside a fleet workspace` | 1 |
| Invalid agent state | `fagent: invalid state "<state>"; expected one of: idle, planning, building, verifying, awaiting` | 1 |
| Could not reach the ship | `fagent: could not reach ship at <baseUrl>: <message>` | 1 |
| HTTP request failed | `fagent: request failed (<status>): <message>` | 1 |
