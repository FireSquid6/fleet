#!/usr/bin/env bash
# activate-fleet-skill.sh — Claude Code SessionStart hook.
#
# When a session starts inside a fleet workspace, tell the agent to activate the
# `fleet-agent` skill. A SessionStart hook's stdout is injected into the model's
# context on exit 0, so we print the instruction only when we are actually inside
# a workspace and otherwise stay completely silent.
#
# This mirrors the OpenCode `session.start` plugin (plugins/opencode.js); keep the
# wording of the injected instruction in sync with it.
set -u

# No fleet CLI on PATH → this isn't a fleet-managed environment; do nothing.
command -v fleet >/dev/null 2>&1 || exit 0

# `fleet agent in-workspace` prints `repo/name` and exits 0 inside a workspace,
# and exits non-zero otherwise (printing "no workspace"). Guard on the exit
# status so that "no workspace" line never leaks into the model's context.
workspace="$(fleet agent in-workspace 2>/dev/null)" || exit 0

# Only inject context when output is exactly a single `repo/name`.
workspace="${workspace%$'\r'}"
workspace="${workspace%$'\n'}"
[[ "$workspace" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 0

cat <<EOF
You are running inside fleet workspace ${workspace}. Before doing any work, use the skill tool to activate the fleet-agent skill and follow its instructions for this session.
EOF

exit 0
