# Startup activation — telling agents to activate the `fleet-agent` skill

The [`skill-installer`](../packages/fleet-ship/src/skill-installer.ts) drops the
`fleet-agent` **skill** into each provider's skills directory, but a skill only
does something once it's *activated*. We want an agent that boots inside a fleet
workspace to activate it on its own, with no human prompting. The
[`plugin-installer`](../packages/fleet-ship/src/plugin-installer.ts) handles that
by installing a small startup plugin/hook per provider.

The two installers have a clean split of responsibility:

- **skill-installer** installs `SKILL.md` files, and nothing else.
- **plugin-installer** installs the startup plugins/hooks, and nothing else.

Both run when the ship boots ([`src/index.ts`](../packages/fleet-ship/src/index.ts))
and share the symlink-safe file helpers in
[`managed-fs.ts`](../packages/fleet-ship/src/managed-fs.ts), which refuse to
follow a symlink or overwrite a non-file so they never damage anything a user
manages by hand.

## What the plugin does

Every provider's plugin runs the same logic on session start:

1. Run `fleet-agent in-workspace`.
2. If the `fleet-agent` CLI isn't on `PATH`, do nothing — this isn't a
   fleet-managed environment.
3. If the command succeeds (it printed `repo/name`), inject an instruction
   telling the agent to activate the `fleet-agent` skill. Otherwise stay silent
   (outside a workspace `in-workspace` exits non-zero).

Only the *packaging* differs per provider; the wording of the injected
instruction is kept in sync across all of them.

## Per-provider packaging

| Provider | Source | Installed to | Mechanism |
|----------|--------|--------------|-----------|
| claude-code | `plugins/claude-code/` (tree) | `~/.claude/skills/fleet-agent-bootstrap/` | Plugin dir with a `.claude-plugin/plugin.json` + a `SessionStart` command hook. Auto-loaded from the skills dir. |
| opencode | `plugins/opencode.js` (file) | `~/.config/opencode/plugins/fleet-agent.js` | A `session.start` plugin module. Auto-loaded from the plugins dir. |
| copilot | `plugins/copilot/session-start-hook.json` (file) | `~/.copilot/hooks/fleet-agent-session-start.json` | A `sessionStart` hook JSON. Auto-loaded from the hooks dir. |

All three targets are auto-discovered by their harness, so installing is just a
matter of mirroring the source into the right directory — no marketplace entry
and no config-file edit. That's why the installer is a single symlink-safe copy
routine over a per-provider file list; a directory tree (claude-code) and a
single file (opencode, copilot) are just different-length file lists.

### Why a Claude Code plugin (not a settings.json hook)

Claude Code has no auto-discovered drop-in directory for bare *hooks* — a raw
SessionStart hook would mean editing the user's `~/.claude/settings.json`, which
is invasive. It *does* auto-load any directory under `~/.claude/skills/` that
contains a `.claude-plugin/plugin.json` manifest as a **plugin**, hooks and all.
So the plugin is the clean drop-in; its `hooks.json` points at the hook script
via `${CLAUDE_PLUGIN_ROOT}`, the plugin's own install directory.

## Installation

[`installFleetPlugin()`](../packages/fleet-ship/src/plugin-installer.ts) walks
the per-provider specs and, for each provider whose config root exists:

- no-ops when the config root is absent (that provider isn't installed);
- otherwise mirrors the source into the install location, marking any `.sh`
  executable;
- is idempotent — unchanged files are left alone and the returned status
  (`installed` / `updated` / `unchanged`) reflects what actually moved.

## Managing it by hand

The ship auto-installs on boot, but the `ship plugin` command group lets you
inspect and (re)install on demand:

- `fleet-cli ship plugin doctor` — read-only report of the skill and plugin
  state (`current` / `stale` / `missing` / `absent`) for every provider.
- `fleet-cli ship plugin install <provider|all>` — install both the skill and
  the plugin for one provider (`claude-code`, `opencode`, `copilot`, `codex`) or
  all of them. `codex` installs the skill only (it has no plugin).

## Codex — not handled here (yet)

Codex is intentionally excluded from the plugin installer. Unlike the others it
has no auto-load drop-in: per [docs/codex.md](./codex.md) it requires running the
`codex plugin` CLI (`marketplace add` + `add`) *and* a manual `/hooks` trust
approval, so it cannot be installed unattended. When we add it, the Codex plugin
source belongs under `plugins/codex/` and its installer step will need to shell
out to `codex plugin` rather than copy files.
