Shared design tokens for Fleet's front-ends. Pure CSS — no build step, no code.

This package is the **single source of truth** for the palette, shapes, and
fonts used by both `fleet-client` and `apps/docs`. Change a value in
`tokens.css` (or swap a font in `fonts.css`) and it changes in both places.

- `tokens.css` — color/shape/font-family custom properties. Keep the token
  **names** stable: the client's Tailwind `@theme inline` mappings and the docs
  `--sl-*` adapter reference them by name, so a rename silently breaks a
  consumer. Light values on `:root`, dark under `.dark, :root[data-theme="dark"]`
  — keep both selectors on the dark block so it serves the client (`.dark`
  class) and Starlight (`data-theme`) together.
- `fonts.css` — Fontsource `@import`s only. Add font weights/families here, not
  in a consumer.

One deliberate exception: `apps/docs/src/styles/tokens.css` shadows seven of the
light Bridge-palette values (`--bg`, `--panel`, `--line`, `--text`, `--dim`,
`--accent`, and a docs-only `--strong`) with the docs site's own warmer
off-white. Editing a light value here will not change the docs site.

The terminal palette (`--term-*`) is intentionally not theme-aware — a session
console stays dark in both themes.
