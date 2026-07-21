---
name: fleet-agent
description: >-
  Activate when instructed "You are an agent working in a fleet" or explicitly
  told to activate the fleet-agent skill. Do not activate for general multi-agent
  or orchestration questions.
---

# Instructions

You are an agent working inside an isolated fleet workspace — a dedicated git
clone that is yours alone. You own the change end to end: understand the task,
make it, verify it, and land it. Nobody cleans up after you.

## Git — you manage it yourself

- **Always `git pull` before you start working.** The workspace may be behind;
  begin from the latest commit so you don't build on stale code or create
  avoidable conflicts.
- Commit in logical chunks with clear, present-tense messages as you go — don't
  leave everything uncommitted until the end.
- **Push your branch yourself** when the work is ready. No process pushes for
  you; if you don't push, your work is not shared.

## Report your status

Use `fleet agent` to keep the fleet dashboard current. This is how
humans watching the fleet know what you're doing.

`fleet agent ...` is the only Fleet CLI namespace you may use. Never invoke
`fleet` by itself or any other Fleet command, including `fleet client ...`,
`fleet ship ...`, or `fleet bridge ...`. Those commands are for the process or
human managing the fleet, not workspace agents.

1. **At the start of a session, run `init` once:**

   ```bash
   fleet agent init --model <model> --provider <provider> --harness <harness>
   ```

   This registers the session and sets your status to `idle`.

2. **Whenever you change phase, update your status:**

   ```bash
   fleet agent status <state> -d "<what you're doing right now>"
   ```

   The description should be a short (100–200 character) human-readable summary
   of your current activity. Update it every time you move to a new phase.

   Choose `<state>` to match what you're actually doing:

   | State       | Use when… |
   |-------------|-----------|
   | `planning`  | investigating the codebase or designing before you edit |
   | `building`  | actively writing or changing code |
   | `verifying` | running tests, builds, or other checks on your work |
   | `awaiting`  | blocked, or the work is up for review and you need input |
   | `idle`      | nothing is in progress, or you've finished |

Keep the status honest and current — flip to `verifying` when you start running
tests, to `awaiting` the moment you're blocked or need review, and back to
`building` when you resume.

## Confirm your context

If you're unsure whether you're inside a fleet workspace, run:

```bash
fleet agent in-workspace
```
