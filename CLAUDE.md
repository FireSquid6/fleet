# autosmith

A Bun monorepo. Each `apps/*` and `packages/*` has its own `CLAUDE.md` with
Bun-specific guidance (use `bun`, `Bun.serve`, `bun test`, etc.) — follow it.

## Comments: explain *why*, not *what*

Comments must add information the code cannot express on its own. A comment that
restates what the adjacent code plainly does is noise: it duplicates the code
(a DRY violation), and it silently rots when the code changes. Delete such
comments; make the code itself readable instead.

**Remove** — comments that only restate the code:

```ts
// BAD: echoes the symbol name
/** Kill this pane. */
async kill() { ... }

// BAD: restates the very next line
// Serve index.html for all unmatched routes.
"/*": index,

// BAD: narrates an obvious flag
// Enable hot reloading
hmr: true,
```

**Keep** — comments that carry information the code cannot:

- *Why* something is done: rationale, trade-offs, invariants, ordering
  constraints, race conditions, gotchas, workarounds for external behavior.
- The underlying command/API a wrapper drives, when not obvious from the code
  (e.g. `/** Delete a branch (\`branch -d\`, or \`-D\` with force). */`).
- Non-obvious return/parameter conventions
  (e.g. "returns `""` when HEAD is detached").
- Module/file-header docs describing a component's role and design.
- Section dividers (`// --- lifecycle ---`) used to navigate a long file.

Rule of thumb: if deleting the comment loses no information a reader couldn't get
from the code in a second, delete it. When a comment feels necessary to explain
*what* the code does, prefer clearer names/structure over the comment.
