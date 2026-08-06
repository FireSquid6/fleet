# autosmith

A Bun monorepo. Each `apps/*` and `packages/*` has its own `CLAUDE.md` with
Bun-specific guidance (use `bun`, `Bun.serve`, `bun test`, etc.) — follow it.

## Comments: the right number is zero

The correct number of comments in new code is **zero**. Writing one is an
exception you must justify, not a stylistic choice — if you cannot name which
permitted case below it falls under, do not write it.

**"It explains *why*" is not a justification.** Rationale about how this
codebase's own pieces fit together — the order two of our functions must run in,
what another module in this repo does, an invariant a reader could establish by
reading the code it refers to — is not a licence to comment. When the reasoning
lives in this repo, the code, the names, and the commit message carry it.

```ts
// BAD: echoes the symbol name
/** Kill this pane. */
async kill() { ... }

// BAD: restates the very next line
// Serve index.html for all unmatched routes.
"/*": index,

// BAD: a "why" whose answer is in our own source
// Listening has to precede `init`: init connects to the persisted roster, and
// every ship that comes online pulls `GET /armory` back off this port.
const app = createApp(manager);
```

**The only comments worth writing**, and nothing else:

- A workaround for a bug or quirk in *external* software — link the issue.
- A deviation forced by a spec, protocol, or wire format — cite it.
- A unit or convention no type can express (`// milliseconds since boot`,
  "returns `""` when HEAD is detached").
- A genuinely unobvious algorithm or formula — cite the source.

**Hard limits:**

- **Two lines, maximum.** An explanation that needs a paragraph belongs in the
  commit message, the PR, or a doc — never in the source.
- **No doc blocks (`/** … */`) on internal functions, types, or helpers.** Where
  a package already documents its public exports in that style, match it; never
  introduce it where it does not exist.
- **No comments in test files at all**, including doc blocks on fixtures and
  helpers. A test's name is its documentation.

**Delete on sight:** restatements of the code; section dividers and banners
(`// --- lifecycle ---`); step narration inside a function (`// Step 1: parse`);
module/file-header blocks; change narration aimed at a diff reader (`// new`,
`// changed from foo`); commented-out code; docstrings that echo the signature;
TODO/FIXME nobody asked for.

Do not add commentary to code you are merely touching, and do not rewrite
existing comments gratuitously — update one only when your change made it wrong.

Rule of thumb: if deleting the comment loses nothing a reader couldn't recover
from the code in seconds, it should not exist.

## Database
Two **very important** rules for
- API routes should never directly interact with drizzle ORM queries. They should always be locked behind some `ThingService` class.
- **Never** do `import { ... } from "../src/db/schema.ts`. Always import as a namespace `import * as schema from "../src/db/schema.ts`.
