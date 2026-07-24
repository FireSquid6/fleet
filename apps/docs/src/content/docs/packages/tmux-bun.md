---
title: tmux-bun
description: A typed, headless wrapper around the tmux CLI for Bun, confined to its own isolated tmux server.
sidebar:
  order: 3
---

`tmux-bun` controls tmux — sessions, windows, and panes — by wrapping the tmux
CLI in a typed, object-oriented API. It drives tmux **headlessly**: it never
attaches to a terminal, and every instance is confined to its own isolated tmux
server, so a program using it can never list, touch, or kill the sessions you
run by hand.

The object model is a straight chain: `Tmux` → `Session` → `Window` → `Pane`.

```ts
import { Tmux } from "tmux-bun";

const tmux = new Tmux({ namespace: "fleet" });

const session = await tmux.newSession({ name: "build", dir: "/srv/app" });
const window = await session.newWindow({ name: "server" });
const pane = await window.split({ direction: "horizontal", percent: true, size: 40 });

await pane.sendKeys("bun run dev", { enter: true });
console.log(await pane.capture());

await tmux.killServer();
```

## Namespaces and isolated servers

The constructor takes a `TmuxOptions` (an alias for `TmuxCommandOptions`) and an
optional backend:

```ts
new Tmux(options: TmuxOptions, backend?: TmuxBackend)
```

| Option | Type | Meaning |
| --- | --- | --- |
| `namespace` | `string` | Server namespace, injected as `-L <namespace>`. Runs a private tmux server on its own socket. |
| `socketPath` | `string?` | Explicit socket path, injected as `-S <socketPath>`. Takes precedence over `-L`. |
| `binary` | `string?` | tmux executable name/path. Defaults to `"tmux"`. |
| `configFile` | `string?` | Config file loaded when the server starts (`-f`). Defaults to tmux's own default, i.e. the user's `~/.tmux.conf`. |

The namespace is readable as `tmux.namespace`.

Isolation is a hard guarantee, not a convention: a single command helper
prepends the socket-selecting flags to **every** invocation, and no higher-level
method ever constructs them itself. `killServer()` therefore tears down only
this namespace's server.

:::caution
By default the namespace's server still loads the user's `~/.tmux.conf`, so
settings like `base-index` and `pane-base-index` can shift indices out from
under index-based addressing. Pass `configFile: "/dev/null"` for fully
deterministic behavior at tmux's built-in defaults.
:::

```ts
const deterministic = new Tmux({
  namespace: "fleet",
  configFile: "/dev/null",
});

const throwaway = new Tmux({
  namespace: "test",
  socketPath: "/tmp/test-run/tmux.sock",  // -S wins over -L
});
```

## The server

| Method | Signature | Behavior |
| --- | --- | --- |
| `isRunning` | `() => Promise<boolean>` | Whether this namespace's server is up. A running server always has at least one session, so a successful `list-sessions` implies "running". |
| `killServer` | `() => Promise<void>` | Kill this namespace's server and all its sessions. Idempotent — "no server running" counts as already done. |
| `newSession` | `(options?: NewSessionOptions) => Promise<Session>` | `new-session -d`. Starts the server if needed. |
| `listSessions` | `() => Promise<SessionInfo[]>` | Returns `[]` when the server is not running. |
| `hasSession` | `(name: string) => Promise<boolean>` | `has-session -t <name>`. |
| `session` | `(ref: string) => Session` | Handle by name or id, **without** checking existence. |
| `getOption` | `(name: string, scope?: OptionScope) => Promise<string \| undefined>` | `show-options -v`. `undefined` when unset. |
| `setOption` | `(name: string, value: string, scope?: OptionScope) => Promise<void>` | `set-option`. |

## Sessions

`newSession` always passes `-d`, so it never attaches to your terminal, and
`-P -F '#{session_id}'` so the returned handle is keyed by the session's stable
id.

```ts
const session = await tmux.newSession({
  name: "build",
  dir: "/srv/app",
  width: 200,
  height: 50,
});

console.log(session.target);      // "$0"
console.log(await session.info());
// SessionInfo: { id, name, windows, attached, created }
```

`NewSessionOptions` is `{ name?, dir?, command?, width?, height? }`, mapping to
`-s`, `-c`, a trailing command argument, `-x`, and `-y`.

| Method | Signature | Behavior |
| --- | --- | --- |
| `info` | `() => Promise<SessionInfo>` | Current metadata. Throws when the session no longer exists. |
| `exists` | `() => Promise<boolean>` | `has-session`. Genuine errors still throw. |
| `rename` | `(name: string) => Promise<void>` | `rename-session`. |
| `kill` | `() => Promise<void>` | Kill the session and all its windows. |
| `newWindow` | `(options?: NewWindowOptions) => Promise<Window>` | Returns a handle keyed by window id. |
| `listWindows` | `() => Promise<WindowInfo[]>` | |
| `window` | `(ref: string \| number) => Window` | A `"@N"` id is used directly; anything else is a name or index within this session. |

## Windows

```ts
const window = await session.newWindow({ name: "server", dir: "/srv/app" });
console.log(window.target);   // "@1"

await window.rename("api");
await window.select();

for (const w of await session.listWindows()) {
  console.log(w.id, w.name, w.index, w.active, w.panes, w.width, w.height);
}
```

`NewWindowOptions` is `{ name?, dir?, command?, select? }`. `select` defaults to
`true`; passing `false` adds `-d` so the window is created in the background.

| Method | Signature | Behavior |
| --- | --- | --- |
| `info` | `() => Promise<WindowInfo>` | Throws when the window is gone. |
| `exists` | `() => Promise<boolean>` | Decided by a non-empty expanded `#{window_id}` — `display-message` exits 0 even for a dead target. |
| `rename` | `(name: string) => Promise<void>` | |
| `select` | `() => Promise<void>` | Make this the session's active window. |
| `kill` | `() => Promise<void>` | Kill the window and all its panes. |
| `split` | `(options: SplitOptions) => Promise<Pane>` | Splits the window's **active** pane. |
| `listPanes` | `() => Promise<PaneInfo[]>` | |
| `pane` | `(ref: string \| number) => Pane` | A `"%N"` id is used directly; anything else is a pane index within this window. |

## Panes

`Pane` is where the actual work happens.

| Method | Signature | Behavior |
| --- | --- | --- |
| `info` | `() => Promise<PaneInfo>` | `{ id, index, active, width, height, title, currentPath, currentCommand, pid }`. |
| `exists` | `() => Promise<boolean>` | Non-empty expanded `#{pane_id}`. |
| `split` | `(options: SplitOptions) => Promise<Pane>` | Returns a handle to the new pane. |
| `select` | `() => Promise<void>` | Make this the window's active pane. |
| `resize` | `(options: ResizeOptions) => Promise<void>` | Directional and/or absolute. |
| `kill` | `() => Promise<void>` | `kill-pane`. |
| `sendKeys` | `(text: string, options?: SendKeysOptions) => Promise<void>` | Send literal text, optionally followed by Enter. |
| `capture` | `(options?: CaptureOptions) => Promise<string>` | `capture-pane -p`. |
| `run` | `(command: string, options?: RunOptions) => Promise<string>` | Type a command, wait, return only its output. |

### Splitting and resizing

```ts
const right = await pane.split({ direction: "horizontal", percent: true, size: 40 });
const bottom = await pane.split({ direction: "vertical", size: 10, select: false });

await right.resize({ direction: "left", amount: 5 });
await right.resize({ width: 100, height: 30 });
```

`SplitOptions` is `{ direction, size?, percent?, dir?, command?, select? }`.
`SplitDirection` is `"horizontal"` (side by side, tmux's `-h`) or `"vertical"`
(stacked, `-v`). `size` becomes `-l`, rendered as `<n>%` when `percent` is set.
`select` defaults to `true`; `false` adds `-d`.

`ResizeOptions` is `{ direction?, amount?, width?, height? }`, where
`ResizeDirection` is `"left" | "right" | "up" | "down"` and `amount` defaults to
`1`. The directional and absolute forms may be combined in one call.

### Sending input

```ts
await pane.sendKeys("bun run dev", { enter: true });
await pane.sendKeys("C-c");            // literal characters "C", "-", "c"
```

:::caution
`sendKeys` sends its text with `-l` (literal) and terminates option parsing with
`--`, so tmux never reinterprets a substring as a key name. That means you
cannot send a control key by naming it — `"C-c"` arrives as three characters.
The only key name it will send is the trailing `Enter` from
`{ enter: true }`, which is issued as a separate `send-keys` call. To send other
control keys, use the escape hatch: `tmux.command.run(["send-keys", "-t", pane.target, "C-c"])`.
:::

### Capturing

```ts
const visible = await pane.capture();
const withScrollback = await pane.capture({ start: -200, end: 0 });
const withColor = await pane.capture({ escapes: true });
```

`CaptureOptions` is `{ start?, end?, escapes? }` mapping to `-S`, `-E`, and `-e`.
Negative `start` values reach into scrollback.

### Running a command and reading its output

`Pane.run` types a command into the pane, waits for it to finish, and returns
only that command's output. It works by bracketing the command with printed
marker lines built from a random nonce, then polling `capture-pane` until the end
marker appears on a line of its own.

```ts
const sha = await pane.run("git rev-parse HEAD", { timeoutMs: 10_000 });
```

`RunOptions` is `{ timeoutMs?, pollMs? }`, defaulting to `5000` and `50`. It
throws when the deadline passes before the end marker shows up.

:::caution
`run` is best-effort by nature: it assumes an interactive shell sitting at a
prompt, and that the output fits the captured region. For deterministic,
non-interactive execution, use the low-level command helper or spawn the process
directly instead.
:::

## Stable-id addressing

Every handle carries a `target` string — the `-t` argument the underlying tmux
commands use. `newSession`, `newWindow`, and `split` all pass `-P -F '#{…_id}'`,
so the handles they return are keyed by tmux's **server-unique ids** (`$0`,
`@0`, `%0`) rather than by names or indices. Those ids survive renames and
reindexing, so a handle keeps working when a sibling window is closed or a
session is renamed.

Names and indices still work as targets when you want them:

```ts
import { buildTarget } from "tmux-bun";

const byName = tmux.session("build");          // target "build"
const byIndex = byName.window(1);              // target "build:1"
const pane = byIndex.pane(0);                  // target "build:1.0"

buildTarget({ session: "build", window: 1, pane: 0 }); // "build:1.0"
```

`buildTarget(parts: TargetParts): string` assembles `session:window.pane` from
`{ session?, window?, pane? }`; ids are valid targets on their own, so it is only
needed for name/index addressing.

## Options

```ts
await tmux.setOption("history-limit", "50000", { global: true });
const limit = await tmux.getOption("history-limit", { global: true });

await tmux.setOption("status", "off", { target: session.target });
```

`OptionScope` is `{ global?, target? }`, mapping to `-g` and `-t`. `getOption`
returns `undefined` for an unset option — including when tmux reports an unknown
or invalid option — rather than throwing.

## Values, not exceptions

Existence probes return values; genuine failures throw:

- `tmux.hasSession(name)`, `session.exists()`, `window.exists()`,
  `pane.exists()` return booleans.
- `tmux.listSessions()` returns `[]` when the server is not running.
- `tmux.killServer()` is idempotent.
- `tmux.getOption(...)` returns `undefined` when unset.
- Everything else throws `TmuxError` on a non-zero exit.

```ts
import { TmuxError } from "tmux-bun";

try {
  await tmux.session("nope").kill();
} catch (error) {
  if (error instanceof TmuxError) {
    console.error(error.args);      // readonly string[] — the argv, minus the binary
    console.error(error.exitCode);  // number
    console.error(error.stderr);    // string
    console.error(error.stdout);    // string
  }
}
```

`TmuxError.message` is formatted as
`tmux <args> failed (exit <code>): <stderr or stdout or "no output">`.

:::note
The methods that translate an expected failure themselves throw a plain `Error`
rather than a `TmuxError` when something *unexpected* goes wrong — `isRunning`,
`killServer`, `listSessions`, and `getOption` do this, as do
`info()` calls whose target has disappeared. Catch `Error` if you need to be
exhaustive.
:::

## The low-level escape hatch

Every call goes through one `TmuxCommand`, exposed as `tmux.command` for
subcommands that are not wrapped. It is still namespace-confined:

```ts
const term = await tmux.command.run(["display-message", "-p", "#{client_termname}"]);

// tryRun never throws — inspect the exit code yourself.
const res = await tmux.command.tryRun(["has-session", "-t", "build"]);
```

| Member | Signature | Behavior |
| --- | --- | --- |
| `command.namespace` | `string` | The bound namespace. |
| `command.run` | `(args: readonly string[]) => Promise<string>` | Throws `TmuxError` on non-zero exit. Returns raw, untrimmed stdout. |
| `command.tryRun` | `(args: readonly string[]) => Promise<TmuxRunResult>` | Never throws. `{ stdout, stderr, exitCode }`. |

The flags are prepended in a fixed order: `-f <configFile>` first (it is a server
option), then the socket selector — `-S <socketPath>` when set, otherwise
`-L <namespace>`.

### Swapping the transport

`TmuxCommand` is the single transport seam. Implement `TmuxBackend` to replace
it — a control-mode (`tmux -C`) backend, for instance, could be dropped in
without touching a single call site:

```ts
import { Tmux, type TmuxBackend, type TmuxRunResult } from "tmux-bun";

const recording: TmuxBackend = {
  async run(args: readonly string[]): Promise<TmuxRunResult> {
    console.log("tmux", args.join(" "));
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

const tmux = new Tmux({ namespace: "fleet" }, recording);
```

The `args` a backend receives already include the socket flags, so a backend must
never inject its own. The default `ShellBackend` spawns one-shot processes via
`Bun.$`, which escapes each array element into a distinct argv entry.

## Teardown

`killServer()` tears down the whole namespace — every session, window, and pane
on that socket — and nothing outside it:

```ts
await tmux.killServer();
console.log(await tmux.isRunning()); // false
```

Finer-grained teardown is available at each level: `session.kill()`,
`window.kill()`, `pane.kill()`.

## No "attach"

The library exposes no `attach`, or anything else that would hand your terminal
over to tmux. To watch a namespaced session by hand, attach yourself from a
shell:

```bash
tmux -L fleet attach -t build
```

## Testing

```bash
cd packages/tmux-bun
bun test
```

The end-to-end suite runs against a dedicated test namespace on a throwaway
socket — never your default tmux server — and includes a test proving isolation
from the default socket. It skips gracefully when `tmux` is not on `PATH`.
