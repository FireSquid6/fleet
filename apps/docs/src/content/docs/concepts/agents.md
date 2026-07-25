---
title: Agents
description: The contract an agent follows inside a workspace, and how the ship teaches it that contract.
sidebar:
  order: 7
---

An *agent* is whatever coding harness is running inside a workspace's tmux
session — Claude Code, OpenCode, Copilot CLI, Codex. Fleet does not launch it and
does not supervise it. What Fleet defines is a small contract the agent follows
so that humans watching the fleet know what it's doing.

The contract has three parts: **discover** where you are, **register** a
session, **report** your status as it changes.

## Agent states

An agent's status is a state plus a human-readable description:

| State | Use when |
|---|---|
| `idle` | nothing is in progress, or the work is finished |
| `planning` | investigating the codebase or designing before editing |
| `building` | actively writing or changing code |
| `verifying` | running tests, builds, or other checks |
| `awaiting` | blocked, or the work is up for review and needs input |

The description is meant to be a short (100–200 character) summary of the
current activity, refreshed on every phase change — not a static label.

`awaiting` is load-bearing. The skill instructs agents to switch to `awaiting`
*before* presenting any question, plan, or approval request, so a dashboard can
distinguish "thinking" from "waiting on a human" without anyone watching the
terminal.

## Discovering the workspace

An agent gets no environment variables and no arguments. It figures out where it
is by walking up from its working directory until it finds the ship's
`atlas.json`, then reading the workspace identity out of the path below it — see
[Ships](/concepts/ships/).

```bash
fleet agent in-workspace
# api-gateway/fix-auth      (exit 0)
# no workspace              (exit 1)
```

Every other `fleet agent` command does the same lookup first, and exits with an
error if it isn't inside a workspace.

## Registering a session

```bash
fleet agent init --model claude-opus-4-8 --provider anthropic --harness claude-code
```

This posts to the ship's `agent/init` route for the workspace. It requires an
**active** workspace — the agent lives in the tmux session, so a session must
exist — and returns a fresh status seeded to `idle` with a description recording
when the session was created.

`model`, `provider`, and `harness` are free text. They are recorded once at
init and preserved across every later status update, which is how the dashboard
can show what is driving each workspace.

Calling `init` again resets the session rather than failing, which makes it safe
to run unconditionally at the start of a harness session.

## Reporting status

```bash
fleet agent status building -d "Adding retry handling to the token refresh path"
```

This updates only the state and description; the model/provider/harness from
`init` are carried over. Updating a workspace where no agent has run `init` is a
`400` — status is session state, not workspace state.

Every `init` and every update emits a `workspace.agent_status_changed` event
carrying the workspace's full summary, so the GUI reflects it immediately. See
[Events](/concepts/events/).

### The status is deliberately ephemeral

Agent status lives in memory on the ship, keyed by workspace, and is dropped
when the workspace is deactivated or removed. It does not survive a ship
restart. That is intentional: the status describes a *running session*, and a
persisted "building" from a process that died two days ago would be a lie.

## What the agent owns

The skill is explicit that the agent — not Fleet — manages git in its workspace:
pull before starting, commit in logical chunks as you go, and push your branch
yourself when the work is ready. No Fleet process commits, pushes, or merges on
an agent's behalf. A workspace whose branch is never pushed simply loses its
work when it's removed.

The skill also restricts agents to the `fleet agent` namespace. `fleet client`,
`fleet ship`, and `fleet bridge` are for the human or process managing the
fleet; an agent that can reconfigure the fleet it runs in is a problem, not a
feature.

## How the ship teaches agents the contract

None of the above works if the agent has never heard of it. So a ship, on
startup, installs two things into the current user's home directory:

**The `fleet-agent` skill** — a single `SKILL.md` describing everything on this
page, written into whichever harnesses are actually present:

| Harness | Skill path |
|---|---|
| Claude Code | `~/.claude/skills/fleet-agent/SKILL.md` |
| OpenCode | `~/.config/opencode/skills/fleet-agent/SKILL.md` |
| Copilot | `~/.copilot/skills/fleet-agent/SKILL.md` |
| Codex | `~/.codex/skills/fleet-agent/SKILL.md` and `~/.agents/skills/fleet-agent/SKILL.md` |

A harness is only touched if its config root already exists — installing a ship
does not create `~/.claude` for someone who doesn't use Claude Code.

**A startup plugin** that makes the agent activate the skill. Each one runs
`fleet agent in-workspace` when a session starts and, only if that succeeds and
prints a clean `repo/name`, injects an instruction to activate the
`fleet-agent` skill before doing anything else. Outside a workspace they print
nothing at all.

| Harness | Mechanism |
|---|---|
| Claude Code | a plugin directory with a `SessionStart` command hook |
| OpenCode | a `session.start` plugin module in `~/.config/opencode/plugins/` |
| Copilot | a `sessionStart` hook JSON in `~/.copilot/hooks/` |
| Codex | none — no drop-in directory, so it needs manual setup |

Codex gets the skill but no plugin: it has no auto-discovered plugin directory
and requires a manual hook-trust step, so it cannot be installed unattended.

## Install bookkeeping

Fleet does not blindly overwrite files in your home directory. Every managed
file is tracked in a manifest at
`~/.config/autosmith/fleet-ship/managed-files-v1.json` recording its provider,
kind, and content hash. Each write reports one of:

| Status | Meaning |
|---|---|
| `installed` | the file didn't exist |
| `updated` | Fleet's previous version was replaced |
| `unchanged` | already current |
| `adopted` | an identical file existed and is now tracked |
| `conflict` | the file exists, isn't Fleet's, and was **left alone** |

Writes are atomic and refuse to follow symlinks or traverse outside the home
directory, and concurrent installs are serialized across processes.

Conflicts are reported as warnings and never silently resolved. To inspect the
state of every harness:

```bash
fleet ship plugin doctor
```

To reinstall, optionally claiming a conflicting file:

```bash
fleet ship plugin install claude-code --force
fleet ship plugin install all
```

:::note
Installation failures at ship startup are warnings, not fatal. The ship comes up
either way — you just get agents that don't know the protocol until you fix the
reported path and rerun `fleet ship plugin install all`.
:::

See [Agent integrations](/guides/agent-integrations/) for per-harness setup and
[Running agents](/guides/running-agents/) for the day-to-day workflow.
