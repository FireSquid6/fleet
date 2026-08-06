The Fleet documentation site: [Astro](https://astro.build) with the
[Starlight](https://starlight.astro.build) docs theme.

Use Bun, not Node:

- `bun run dev` — dev server on `localhost:4321`
- `bun run build` — production build to `./dist/`
- `bun run typecheck` — `astro check`
- `bunx astro ...` instead of `npx astro ...`

## Layout

| Path | Holds |
| --- | --- |
| `src/content/docs/` | the documentation itself, rendered by Starlight |
| `src/pages/index.astro` | the landing page at `/` — a standalone Astro page, not Starlight |
| `src/components/` | Starlight [component overrides](https://starlight.astro.build/guides/overriding-components/), wired up in `astro.config.mjs` |
| `src/styles/tokens.css` | the shared `fleet-design` tokens plus the docs site's own light-theme values |
| `src/styles/fleet.css` | everything that restyles Starlight; imports `tokens.css` |
| `src/theme-boot.js` | the inline theme scripts, shared by `astro.config.mjs` and the landing page |

A file in `src/pages/` wins over Starlight's injected route, which is how `/`
is the landing page rather than a docs entry. That page is plain HTML with its
own scoped styles: it shares the tokens, not the Starlight stylesheet. It reads
and writes `localStorage['starlight-theme']`, the same key Starlight's own
theme control uses, so the two halves of the site stay in step.

Light-theme colors are overridden in `tokens.css` rather than in
`packages/fleet-design`: those tokens are shared with the web client, which is
not part of this design.

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
