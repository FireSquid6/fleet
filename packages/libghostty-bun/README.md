# libghostty-bun

[`bun:ffi`](https://bun.sh/docs/api/ffi) bindings for **libghostty-vt** — the
zero-dependency virtual-terminal parser/state library extracted from
[ghostty](https://github.com/ghostty-org/ghostty).

It parses a stream of terminal bytes (escape sequences, SGR, cursor movement,
line wrapping, scrollback, reflow-on-resize…) and lets you read back the
resulting grid state — cell text, colors, and style flags — plus cursor
position. **There is no renderer, no PTY, and no windowing** — you render the
grid yourself. That is exactly what libghostty-vt is for.

```ts
import { Terminal } from "libghostty-bun";

using term = new Terminal({ cols: 80, rows: 24 });
term.write("\x1b[31mhi");             // red "hi"

term.cell(0, 0).char;                 // "h"
term.cell(0, 0).fg;                   // { type: "palette", index: 1 }  (red)
term.cursor();                        // { x: 2, y: 0, visible: true, pendingWrap: false }
```

## Status & pinned version

The libghostty-vt **C API is not yet tagged, versioned, or ABI-stable** — its
own header says so. This binding therefore pins an exact ghostty commit and
makes no ABI-stability assumptions across commits.

| | |
|---|---|
| Pinned ghostty commit | [`8642142a3d62beda7b1a9733c23bf11b80c720eb`](https://github.com/ghostty-org/ghostty/commit/8642142a3d62beda7b1a9733c23bf11b80c720eb) |
| ghostty version at that commit | `1.3.2-dev` (libghostty-vt `0.1.0-dev`) |
| Required Zig | `0.15.2` |
| Runtime | Bun (uses `bun:ffi`) |

To bump the pin, change `PINNED_COMMIT` in both `scripts/build.ts` and
`src/raw.ts`, then re-run the build and re-read the headers for API drift.

## Build

Nothing is prebuilt or published; you build the native library from source
once. The build script is self-contained — it downloads a pinned Zig toolchain
if you don't have `0.15.2` on your `PATH`, fetches the pinned ghostty commit,
builds libghostty-vt, and compiles the shim.

```sh
bun install
bun run build          # == bun run scripts/build.ts
```

What that does, step by step:

1. **Zig** — uses `zig 0.15.2` if on `PATH`, otherwise downloads it to
   `vendor/zig-<arch>-<os>-0.15.2/`.
2. **Fetch ghostty** — shallow-fetches the pinned commit into `vendor/ghostty`.
3. **Build libghostty-vt** — the exact command is:
   ```sh
   zig build -Demit-lib-vt=true -Doptimize=ReleaseFast
   ```
   This produces `zig-out/lib/libghostty-vt.so{,.0,.0.1.0}` (or `.dylib` /
   `.dll`), the static `libghostty-vt.a`, and headers under `zig-out/include`.
4. **Compile the shim** — compiles `shim/ghostty_vt_shim.c` into
   `prebuilds/ghostty_vt_shim.<suffix>` (where `<suffix>` comes from
   `bun:ffi`'s `suffix`: `so` / `dylib` / `dll`), dynamically linked against
   libghostty-vt with an `$ORIGIN` / `@loader_path` rpath. The vt shared
   libraries are copied next to it so the rpath resolves them.

Then:

```sh
bun test               # run the test suite (incl. the acceptance criteria)
bun run example        # run examples/basic.ts
```

## Why a C shim?

libghostty-vt's C API passes a few structs **by value** —
`ghostty_terminal_new()` takes `GhosttyTerminalOptions` by value and
`ghostty_terminal_grid_ref()` takes `GhosttyPoint` by value. `bun:ffi`'s
`dlopen` only marshals scalars and pointers, not by-value structs, so those
symbols cannot be bound directly. (The other bun:ffi binding in the wild,
`ts-libghostty`, hits the same wall and also uses a shim.)

`shim/ghostty_vt_shim.c` is a thin layer that includes the **real** vt headers
(so every signature is derived from the header, never guessed), absorbs the
by-value ABI on the C side, and re-exports a flat, scalar/pointer-only surface
(`gt_terminal_new`, `gt_read_cell`, …). It statically references the vt lib and
is compiled with `-fvisibility=hidden`, so only the `gt_*` functions are
exported.

## Architecture

```
scripts/build.ts     build orchestrator (zig toolchain + ghostty + shim)
shim/
  ghostty_vt_shim.h  flat FFI surface + fixed 32-byte GtCellInfo layout
  ghostty_vt_shim.c  implementation over the real <ghostty/vt.h>
src/
  raw.ts             low-level: dlopen + FFI symbol table + struct offsets
  terminal.ts        ergonomic typed `Terminal` class
  index.ts           public entrypoint
examples/basic.ts    runnable demo
test/terminal.test.ts
vendor/              (gitignored) zig toolchain + pinned ghostty checkout
prebuilds/           (gitignored) compiled shim + vt shared libs
```

## Ownership across the FFI boundary

Every pointer/string crossing the boundary has a documented owner (see the
per-function comments in `shim/ghostty_vt_shim.h` and `src/raw.ts`):

- **Terminal handle** — `new Terminal(...)` allocates a C-owned handle
  (`gt_terminal_new`). You **must** release it exactly once with `free()` (or
  `using` / `Symbol.dispose`). After `free()`, every method throws, and `free()`
  is idempotent. This is the only create/free pair.
- **Byte buffers** (`write`, cell reads) — always **caller (JS) owned**. They
  are borrowed by C only for the duration of the synchronous call. The cell-read
  scratch buffer is JS-owned and fully decoded before returning, so there is
  never a dangling read of freed C memory. The underlying grid reference is an
  *untracked snapshot* consumed entirely inside the shim call.
- **`gt_type_json`** returns a pointer to a process-lifetime static string —
  never freed.

The `no-leaks` test drives 5000 create → feed → read → free cycles and asserts
bounded RSS growth plus that freed handles reject all further use.

## API

```ts
class Terminal {
  constructor(opts: { cols: number; rows: number; maxScrollback?: number });

  get cols(): number;
  get rows(): number;

  write(data: string | Uint8Array): void;        // feed VT bytes
  resize(cols, rows, cellWidthPx?, cellHeightPx?): void;
  reset(): void;                                  // RIS (keeps dimensions)

  cell(row: number, col: number): Cell;           // 0-indexed
  cursor(): CursorState;
  rowText(row: number): string;                   // convenience

  free(): void;                                    // release the C handle
  [Symbol.dispose](): void;                        // enables `using`
}

type Color =
  | { type: "default" }
  | { type: "palette"; index: number }             // 0–255; 0–15 named ANSI
  | { type: "rgb"; r: number; g: number; b: number };

interface Cell {
  char: string; codepoint: number; hasText: boolean;
  width: "narrow" | "wide" | "spacer_tail" | "spacer_head";
  fg: Color; bg: Color;
  style: {
    bold; italic; faint; blink; inverse; invisible; strikethrough; overline: boolean;
    underline: "none" | "single" | "double" | "curly" | "dotted" | "dashed";
  };
}

interface CursorState { x: number; y: number; visible: boolean; pendingWrap: boolean; }
```

### Not bound (by design)

- The **surface / rendering API** (`ghostty_app_t`, `ghostty_surface_t`) — out
  of scope; libghostty-vt doesn't render.
- **Cursor shape** (bar/block/underline) — at the pinned commit the C API does
  **not** expose a getter for the cursor's visual shape (only its SGR style and
  visibility), so it isn't surfaced here. Cursor *position* and *visibility*
  are. This is a limitation of the pinned WIP API, not of the binding.

## Publishing to npm

The published package ships a **prebuilt native library for the publisher's
platform** plus a source-build fallback, so most installs are instant and any
uncovered platform builds from source automatically.

### How installs resolve the native library

`postinstall` (`scripts/postinstall.ts`) runs on `npm install` / `bun install`:

- If `prebuilds/ghostty_vt_shim.<suffix>` for the consumer's platform is in the
  tarball → **no-op** (instant).
- Otherwise → builds from source via `scripts/build.ts` (downloads Zig, fetches
  the pinned ghostty commit, compiles the shim). Needs git, a C compiler, and
  network access.
- Skipped automatically in a dev checkout of this repo (so a bare
  `bun install` here never triggers a multi-minute build), and skippable
  anywhere with `LIBGHOSTTY_BUN_SKIP_POSTINSTALL=1`.

### What ships in the tarball

The `files` allowlist ships `src/`, `shim/`, `scripts/`, `prebuilds/`,
`README.md`, and `LICENSE` — the heavy `vendor/` (Zig toolchain + ghostty
checkout) is excluded. Preview it any time:

```sh
bun run pack:dry        # npm pack --dry-run
```

The compiled libghostty-vt is MIT-licensed; its notice is shipped as
`prebuilds/LICENSE-libghostty-vt` next to the binary.

### Releasing

Use the guarded release helper — **it is a dry run unless you pass `--publish`**:

```sh
bun run release                    # dry run: build + typecheck + tests + npm publish --dry-run
bun run release -- --publish       # publish the current version
bun run release -- patch --publish # bump patch (commit + tag), then publish
bun run release -- 0.2.0 --publish # set an explicit version, then publish
```

Flags: `--allow-dirty`, `--tag <dist-tag>`, `--otp <2fa-code>`.

If your npm account has 2FA enabled and you don't pass `--otp`, the script
**prompts for the one-time code interactively** right before uploading (so the
time-limited code is still valid) and passes it to `npm publish --otp`. Pass
`--otp <code>` to skip the prompt in non-interactive/CI environments.

The pre-publish gate (build native → `tsc --noEmit` → `bun test`) runs via the
`prepublishOnly` hook, so it applies to `npm publish` no matter how it's invoked.
`prepack` guarantees the prebuilt binary is present for `npm pack`. After a
version bump, remember to `git push --follow-tags`.

> First-time publish requires `npm login`, and the name `libghostty-bun` must be
> free on the registry. `publishConfig.access` is `public`.

## License

The bindings in this repo follow ghostty's license for the vendored/built
libghostty-vt. See the [ghostty repository](https://github.com/ghostty-org/ghostty).
