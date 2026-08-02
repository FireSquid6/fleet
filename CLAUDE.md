# autosmith

A Bun monorepo. Each `apps/*` and `packages/*` has its own `CLAUDE.md` with
Bun-specific guidance (use `bun`, `Bun.serve`, `bun test`, etc.) — follow it.

## Comments: explain *why*, not *what*

Default to writing **no** comment. A comment must earn its place — add one only
when a competent reader of the code would otherwise be genuinely confused, and
no amount of renaming or restructuring fixes it. A comment that restates what
the adjacent code plainly does is noise: it duplicates the code (a DRY
violation), and it silently rots when the code changes. Delete such comments;
make the code itself readable instead.

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

**Never write:**

- Restatements of the code (`// increment i`, `// set the name`).
- Section dividers and banners (`// --- lifecycle ---`, `// ===== HELPERS =====`)
  or narration inside a function (`// Step 1: parse input`). If a file or
  function needs signposting, split it up or rename things.
- Module/file-header doc blocks describing a component's role and design. The
  module's name and its exports are the documentation.
- Change narration aimed at the reader of a diff (`// added this to fix the
  bug`, `// new`, `// changed from foo to bar`). That belongs in the commit
  message.
- Commented-out code. Delete it; version control remembers.
- Redundant docstrings that only echo the signature and parameter names.
- TODO/FIXME notes unless the user asked for them.
- Comments explaining what a well-named identifier already says — improve the
  name instead.

**Keep** — comments that carry information the code cannot:

- *Why* something is done: rationale, trade-offs, invariants, ordering
  constraints, race conditions, gotchas, workarounds for external behavior
  (link the issue/spec/ticket).
- The underlying command/API a wrapper drives, when not obvious from the code
  (e.g. `/** Delete a branch (\`branch -d\`, or \`-D\` with force). */`).
- Non-obvious return/parameter conventions
  (e.g. "returns `""` when HEAD is detached"), including units.

Rule of thumb: if deleting the comment loses no information a reader couldn't get
from the code in a second, delete it. When a comment feels necessary to explain
*what* the code does, prefer clearer names/structure over the comment.

## Database
Two **very important** rules for
- API routes should never directly interact with drizzle ORM queries. They should always be locked behind some `ThingService` class.
- **Never** do `import { ... } from "../src/db/schema.ts`. Always import as a namespace `import * as schema from "../src/db/schema.ts`.
