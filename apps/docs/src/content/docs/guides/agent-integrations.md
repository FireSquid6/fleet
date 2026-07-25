---
title: Agent integrations
description: The fleet-agent skill and session-start plugins a ship installs for each agent provider, and how to repair them.
sidebar:
  order: 7
---

For an agent to report status, two things have to be true: it must know the
`fleet agent` workflow, and something must tell it to start using that workflow
when it boots inside a workspace.

Fleet ships both. A **skill** (`fleet-agent`) carries the instructions, and a
small **startup plugin** per provider detects a fleet workspace at session start
and injects a mandatory "activate the fleet-agent skill" instruction. A ship
installs both into the agent's home directory every time it starts.

## What happens at ship startup

`fleet ship` installs the skill and the plugins before it begins serving. The
install is best-effort: if it fails, the ship logs a warning and keeps going —
it never blocks the ship from coming up.

```
Fleet startup could not install agent skills: <detail>. Fix the reported path, then run fleet ship plugin install all.
```

Preserved conflicts are reported the same way, one line per file:

```
Fleet startup preserved conflicting claude-code integration file: /home/you/.claude/skills/fleet-agent/SKILL.md. Run fleet ship plugin install claude-code --force to replace it.
```

Installation is keyed off the provider's config directory: a provider is only
touched if its config root (`~/.claude`, `~/.config/opencode`, `~/.copilot`,
`~/.codex`) already exists. Fleet does not create a config root for a tool you
haven't installed.

## Supported providers

| Provider | Skill | Startup plugin |
| --- | --- | --- |
| `claude-code` | `~/.claude/skills/fleet-agent/SKILL.md` | `~/.claude/skills/fleet-agent-bootstrap/` |
| `opencode` | `~/.config/opencode/skills/fleet-agent/SKILL.md` | `~/.config/opencode/plugins/fleet-agent.js` |
| `copilot` | `~/.copilot/skills/fleet-agent/SKILL.md` | `~/.copilot/hooks/fleet-agent-session-start.json` |
| `codex` | `~/.codex/skills/fleet-agent/SKILL.md` and `~/.agents/skills/fleet-agent/SKILL.md` | none |

Codex gets the skill in two places — its own directory and the shared
`~/.agents` location — but no startup plugin: it has no drop-in plugin directory
and needs a manual trust step, so it can't be installed unattended. A Codex agent
has the skill available; something still has to tell it to activate it.

The claude-code plugin is a small directory tree: a `.claude-plugin/plugin.json`
manifest, a `hooks/hooks.json` declaring a `SessionStart` hook, and an executable
`hooks/activate-fleet-skill.sh`.

## What the plugins do

All three implement the same logic in their provider's own idiom:

1. Is a `fleet` binary on `PATH`? If not, stay silent — this isn't a
   Fleet-managed environment.
2. Run `fleet agent in-workspace`. Non-zero exit means we're not inside a
   workspace; stay silent.
3. Check that the output is exactly one `repo/name` pair.
4. Only then inject an instruction naming the workspace and requiring the agent
   to activate the `fleet-agent` skill before doing anything else.

The guards matter: a session started outside a workspace gets nothing injected at
all, and nothing leaks into the model's context.

The skill itself is the source of truth for agent behaviour — the `fleet agent`
commands, the status states, and the git expectations. See [Running
agents](/guides/running-agents/).

## Check the install state

```bash
fleet ship plugin doctor
```

This is read-only. It reports, per provider, whether the provider's CLI is on
`PATH` and what state the skill and plugin files are in:

```
fleet-agent skill & plugin status

claude-code
  cli    ✓ found    claude → ~/.local/bin/claude
  skill  ✓ current  ~/.claude/skills/fleet-agent/SKILL.md
  plugin ✓ current  ~/.claude/skills/fleet-agent-bootstrap
```

| State | Meaning |
| --- | --- |
| `✓ current` | installed and matching what this ship would write |
| `~ outdated-owned` | Fleet's file, but from an older version — reinstall to update |
| `! conflict/unmanaged` | present but not written by Fleet, or edited since |
| `✗ missing` | the provider is installed, the file is not |
| `- absent` | the provider's config directory doesn't exist |

`fleet ship plugin doctor` does not start a ship — it's safe to run anywhere.

## Install or repair by hand

```bash
fleet ship plugin install claude-code
fleet ship plugin install all
```

The argument is one of `claude-code`, `opencode`, `copilot`, `codex`, or `all`.
Anything else exits with an error listing the valid values.

The command re-runs the same installers the ship runs at boot and prints one line
per file:

```
skill   claude-code  unchanged  /home/you/.claude/skills/fleet-agent/SKILL.md
plugin  claude-code  installed  /home/you/.claude/skills/fleet-agent-bootstrap
```

| Status | Meaning |
| --- | --- |
| `installed` | the file did not exist and was written |
| `updated` | Fleet's own file was replaced with new content |
| `unchanged` | already byte-identical |
| `adopted` | the file already existed with exactly the right content, so Fleet claimed ownership of it without writing |
| `conflict` | the file exists but Fleet doesn't own it — **left untouched** |

Naming a single provider that isn't installed on the machine is not an error:

```
opencode: not installed on this machine (config directory missing); nothing to do.
```

## Conflicts and `--force`

Fleet tracks every file it writes in an ownership manifest at
`~/.config/autosmith/fleet-ship/managed-files-v1.json`, recording each path's
expected content hash and mode. A file whose content doesn't match what Fleet
recorded — because you edited it, or because it was never Fleet's — is a
**conflict**.

Conflicts are never overwritten silently. The file is preserved, the command
reports it, and the process exits non-zero:

```
Conflict: /home/you/.claude/skills/fleet-agent/SKILL.md is user-managed or was modified; preserved. Review it, then run fleet ship plugin install claude-code --force to replace it.
```

The non-zero exit is deliberate: it makes a conflict visible in a provisioning
script that would otherwise ignore the message.

Once you've reviewed the file, `--force` replaces it and claims it for Fleet:

```bash
fleet ship plugin install claude-code --force
```

:::caution
`--force` discards your version of the conflicting file. Copy anything you want
to keep out of it first — Fleet keeps no backup.
:::

`--force` only overrides *content* conflicts. Fleet still refuses to write
through a symlink, to replace a non-regular file, or to touch anything outside
the home directory, forced or not. Those raise errors rather than being
overridden.

## Related

- [Running agents](/guides/running-agents/) — the workflow the skill teaches.
- [Agents](/concepts/agents/) — the status model.
- [CLI reference](/reference/cli/) — `fleet ship plugin` flags.
