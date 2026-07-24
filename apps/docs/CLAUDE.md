The Fleet documentation site: [Astro](https://astro.build) with the
[Starlight](https://starlight.astro.build) docs theme.

Use Bun, not Node:

- `bun run dev` — dev server on `localhost:4321`
- `bun run build` — production build to `./dist/`
- `bun run typecheck` — `astro check`
- `bunx astro ...` instead of `npx astro ...`

## Content

Pages are Markdown/MDX under `src/content/docs/`; the route is the file path.
Sections map to the sidebar groups declared in `astro.config.mjs`:

| Directory       | Holds                                                       |
| --------------- | ----------------------------------------------------------- |
| `start/`        | Introduction, installation, quickstart — explicitly ordered |
| `concepts/`     | How Fleet works: architecture, workspaces, ships, events     |
| `guides/`       | Task-oriented walkthroughs                                   |
| `reference/`    | Exhaustive CLI, HTTP API, and config surface                 |
| `packages/`     | Per-package library docs for `packages/*`                    |
| `contributing/` | Repo layout, development, testing                            |

Every group except `start/` is `autogenerate`d, so a new file appears in the
sidebar on its own. Order within a group comes from each page's
`sidebar.order` frontmatter; `start/` is listed by hand in the config instead.

Docs describe the code in this repo. When behavior changes, the page that
documents it changes in the same commit — a reference page that has drifted
from the CLI is worse than no page.
