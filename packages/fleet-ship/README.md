# fleet-ship

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

Workspace tmux session names changed to hashed `ws-<sha256>` targets. Existing
sessions using legacy names are intentionally not discovered or migrated; stop
them manually before or after upgrading if they are no longer needed.

This project was created using `bun init` in bun v1.3.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
