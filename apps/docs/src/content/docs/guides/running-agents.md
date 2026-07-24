---
title: Running agents in a workspace
description: How an agent inside a workspace confirms its context, registers a session, and reports status back to the fleet.
sidebar:
  order: 6
---

`fleet agent` is the namespace an agent uses from *inside* its workspace. It has
exactly three commands, and they need no URL, no ship name, and no workspace
name — the agent's working directory is enough.

Everything else in the CLI (`fleet client`, `fleet ship`, `fleet bridge`) is for
the human or process managing the fleet. The `fleet-agent` skill the ship
installs tells agents so explicitly: `fleet agent ...` is the only namespace they
may use.

## How the commands find the workspace

The ship writes an `atlas.json` discovery file to the root of its fleet
directory, containing the port it is listening on. Workspaces sit two levels
below that, at `<fleetDirectory>/<repo>/<name>`.

So `fleet agent` walks up from the current directory until it finds
`atlas.json`, reads the port, and derives the workspace identity from the first
two path segments below that root. It then talks to `http://localhost:<port>`.

The consequences are worth knowing:

- It works from any subdirectory of the workspace, not just its root.
- It only works on the machine the ship runs on. There is no remote mode.
- If the ship isn't running — or the agent isn't inside a workspace — the
  commands say so and exit non-zero.

## Confirm you're in a workspace

```bash
fleet agent in-workspace
```

Inside a workspace it prints `repo/name` and exits `0`:

```
api-gateway/feature-x
```

Outside one it prints `no workspace` and exits `1`. That exit code is the
contract the session-start hooks rely on — see [Agent
integrations](/guides/agent-integrations/).

## Start a session

```bash
fleet agent init \
  --model claude-opus-4-8 \
  --provider anthropic \
  --harness claude-code
```

```
agent session started on api-gateway/feature-x (idle)
```

All three options are required, and all three are free-form strings — they are
recorded and displayed, not validated against a list. They appear in the GUI's
workspace and repo tables as MODEL / PROVIDER / HARNESS.

Run `init` once at the start of a session. It seeds the status to `idle` with a
generated description; re-running it resets the session.

The workspace must be **active** — the agent status is attached to its tmux
session. On an inactive workspace, `init` fails with `workspace not active`.
Activate it first with [`fleet client
activate`](/guides/managing-workspaces/), or from the GUI.

## Report status

```bash
fleet agent status building -d "Adding the retry path to the upstream client"
```

```
status updated to building on api-gateway/feature-x
```

`-d/--description` is required. Keep it a short human-readable summary of what
you're doing right now — the skill asks for roughly 100–200 characters. It is
what a human watching the dashboard reads.

`status` requires an earlier `init` in the same session; without one it fails
with `agent not initialized`. The model, provider, and harness from `init` are
preserved across every update.

### The states

| State | Use when |
| --- | --- |
| `idle` | nothing is in progress, or the work is finished |
| `planning` | investigating the codebase or designing, before editing |
| `building` | actively writing or changing code |
| `verifying` | running tests, builds, or other checks |
| `awaiting` | blocked, or the work is up for review and you need input |

Any other value is rejected before the request is sent.

### When to update

Update on every phase change — that's the whole point of the field. Concretely:

- Flip to `verifying` when you start running tests, not after they pass.
- Flip to `awaiting` **before** you present a question, a plan, or an approval
  request to the user. The skill makes this mandatory, and it must complete
  before you present the question — don't run the two in parallel.
- Flip back to the state matching your real phase the moment work resumes.
- Flip to `idle` when you're done.

A stale status is worse than none: the dashboard is the only signal a human
watching a dozen workspaces has.

## Status lifetime

Agent status is in-memory runtime state on the ship, tied to the workspace's tmux
session. It is not written to disk. Deactivating or deleting the workspace clears
it, and a restarted ship starts with no agent attached to anything. Every status
change is broadcast on the ship's event stream as
`workspace.agent_status_changed` and flows up through the bridge to the GUI in
real time.

## A typical session

```bash
fleet agent in-workspace          # confirm context
fleet agent init --model claude-opus-4-8 --provider anthropic --harness claude-code

git pull                          # start from the latest commit

fleet agent status planning -d "Reading the upstream client and its tests"
fleet agent status building -d "Adding the retry path to the upstream client"
fleet agent status verifying -d "Running the client test suite"

git push                          # nothing pushes for you

fleet agent status idle -d "Retry path landed and pushed on feature/retry"
```

The workspace is a real clone and the agent owns its git state end to end: pull
before starting, commit in logical chunks, and push the branch yourself. No
process in Fleet commits or pushes on an agent's behalf.

## Related

- [Agents](/concepts/agents/) — the status model and where it lives.
- [Agent integrations](/guides/agent-integrations/) — the skill and session-start
  hooks that get an agent to run these commands in the first place.
- [CLI reference](/reference/cli/) — full flag tables.
