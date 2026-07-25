# fleet-design

The shared design tokens for Fleet's front-ends — the one place to change the
palette, shapes, and typography used by both the web client
([`fleet-client`](../fleet-client)) and the docs site ([`apps/docs`](../../apps/docs)).

Two framework-agnostic CSS files:

| File         | Holds                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `tokens.css` | Color tokens (shadcn base, the "Bridge" palette, status + terminal colors), `--radius`/`--node-radius`, and the `--font-mono`/`--font-prose` family vars. Light on `:root`, dark under `.dark, :root[data-theme="dark"]`. |
| `fonts.css`  | Self-hosted JetBrains Mono + IBM Plex Sans via Fontsource.            |

## Usage

Import the CSS through the package's `exports`:

```css
@import "fleet-design/tokens.css";
@import "fleet-design/fonts.css";
```

Then bind the tokens to your framework:

- **Client** (Tailwind v4): exposes them as utilities with `@theme inline`
  (`bg-bg`, `text-dim`, `font-mono`, …) — see
  `fleet-client/styles/globals.css`.
- **Docs** (Starlight): maps them onto `--sl-*` variables — see
  `apps/docs/src/styles/fleet.css`.

The dark selector is deliberately doubled (`.dark` **and**
`:root[data-theme="dark"]`) so a single token file satisfies the client's
`.dark` class and Starlight's `data-theme` attribute at once.
