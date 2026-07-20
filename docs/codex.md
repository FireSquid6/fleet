# Codex startup activation

Use a small Codex plugin containing a `SessionStart` command hook. This is the
supported lifecycle point for adding model-visible context when a Codex thread
starts or resumes; it is a better fit than changing `AGENTS.md`, because the
check is user-wide but should only affect fleet workspaces.

## Plugin layout

```text
fleet-agent-activation/
├── .codex-plugin/
│   └── plugin.json
└── hooks/
    ├── hooks.json
    └── session-start.sh
```

`.codex-plugin/plugin.json`:

```json
{
  "name": "fleet-agent-activation",
  "version": "1.0.0",
  "description": "Activates fleet-agent inside fleet workspaces.",
  "hooks": "./hooks/hooks.json"
}
```

`hooks/hooks.json`:

```json
{
  "description": "Detect fleet workspaces at Codex startup.",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"$PLUGIN_ROOT/hooks/session-start.sh\"",
            "timeout": 5,
            "statusMessage": "Checking for a fleet workspace"
          }
        ]
      }
    ]
  }
}
```

`hooks/session-start.sh`:

```sh
#!/bin/sh

command -v fleet-agent >/dev/null 2>&1 || exit 0
workspace=$(fleet-agent in-workspace 2>/dev/null) || exit 0

case "$workspace" in
  */*) printf 'You are in fleet workspace %s. Activate the $fleet-agent skill now and follow it for this session.\n' "$workspace" ;;
esac
```

The script deliberately exits successfully and silently when the executable is
missing or `in-workspace` exits non-zero. On success, plain stdout is additional
context visible to the model. `PLUGIN_ROOT` is supplied by Codex and points to
the installed plugin copy, so the hook does not depend on the current working
directory. Include all four start sources so activation is restored after a
resume, `/clear`, or compaction as well as a fresh thread.

## Installation

Package this separately from the existing skill, then have `fleet-ship` install
both. The supported CLI route is to expose the plugin through a local Codex
marketplace and run:

```sh
codex plugin marketplace add /absolute/path/to/fleet-marketplace
codex plugin add fleet-agent-activation@fleet
```

Do not write Codex's plugin cache or `config.toml` state directly; those are
implementation details managed by `codex plugin`. A marketplace entry may use
`policy.installation: "INSTALLED_BY_DEFAULT"` for desktop marketplace
distribution, but a ship-driven CLI install should explicitly invoke
`codex plugin add`.

There is one unavoidable first-run step: installing or enabling a plugin does
not trust its command hooks. The user must open `/hooks` and approve the hook's
current definition; changing the command changes its hash and requires another
review. Fully unattended trust is only available through administrator-managed
hooks or the deliberately unsafe `--dangerously-bypass-hook-trust` flag, neither
of which a normal `fleet-ship` install should assume.

References: [Build plugins](https://learn.chatgpt.com/docs/build-plugins),
[Hooks](https://learn.chatgpt.com/docs/hooks), and
[Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin).
