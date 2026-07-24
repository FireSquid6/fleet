# fleet

Run coding agents in isolated git workspaces, across one machine or many.

```bash
bun install
```

## Documentation

The docs site lives in [`apps/docs`](apps/docs) (Astro + Starlight):

```bash
bun run docs        # dev server on localhost:4321
bun run docs:build  # production build to apps/docs/dist
```

## Development

```bash
bun test        # every workspace's suite
bun typecheck   # every workspace's typecheck
```

See the docs site's Contributing section for the repo layout and conventions.
