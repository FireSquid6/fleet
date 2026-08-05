---
title: The Armory
description: One bridge-owned directory of skills, plugins, and dotfiles, installed on every ship in the fleet.
sidebar:
  order: 9
---

Every agent on every ship wants the same things: the skills you have written, the
provider config you have settled on, the dotfiles you cannot work without. The
Armory is where you keep them once. It is a single directory on the bridge host;
every ship pulls it and installs it, and re-installs it whenever it changes.

It is deliberately one-way. You edit the armory on the bridge — by hand, or by
pointing a git checkout at it — and ships converge on what you wrote. Nothing in
Fleet writes to it, and there is no upload, edit, or delete affordance in the CLI
or the GUI.

## Layout

The armory lives at `<bridge dataDirectory>/armory/`. With the default
`fleet bridge -d ./.fleet-bridge`, that is `./.fleet-bridge/armory/`.

```
armory/
  skills/
    reviewer/
      SKILL.md
      checklist.md
  plugins/
    claude-code/
      commands/
        lint.md
    opencode/
      plugins/
        notify.js
  dotfiles/
    gitconfig
    nvim/
      init.lua
  dotfile-map.json
```

Only `skills/`, `plugins/`, and `dotfiles/` are scanned. Anything else at the
armory root is ignored, except `dotfile-map.json`, which is read as
configuration rather than content.

A ship's copy is not the armory — it is a cache at
`~/.config/autosmith/fleet-ship/armory/files/`, mirroring the tree above. Do not
edit it; the next sync overwrites it.

## How a change reaches a ship

1. The bridge watches the armory directory recursively and collapses a burst of
   writes (a `git pull`, say) into one event.
2. It re-scans the tree into a manifest and pushes
   `POST /armory/sync` to every online ship, carrying its own URL and the new
   revision.
3. Each ship pulls the manifest from `GET /armory`, then fetches only the files
   whose hash it does not already hold, verifying every one against the
   manifest's `sha256` before it lands. This is the one hop that runs
   ship-to-bridge, and the ship authenticates it with its own `shipToken` — see
   [authentication](/guides/authentication/).
4. It installs the cache into place and records what it did.

The revision is a content address: it changes when and only when a file's
contents, mode, or path changes, or the dotfile map changes. Two scans of an
unchanged armory produce the same revision, so a re-push costs a ship nothing.

The bridge also pushes on **ship registration** and on **every arrival at
online**, so a ship that was down, restarted, or newly added catches up on its
own. There is no polling and no schedule — if nothing changes, nothing happens.

A pull is all-or-nothing. One file that fails its hash check, or that the bridge
will not serve, fails the whole sync: the ship keeps the revision it already had
and records the reason rather than applying half an armory.

## Which bridge a ship pulls from

The push names the bridge to pull from, and what is pulled gets installed into
the agent config of whoever runs the ship. So a ship accepts pushes from **one**
bridge and refuses the rest with `403`, having fetched nothing:

- `fleet ship --bridge-url <url>` pins it explicitly. `fleet launch` sets this
  for every ship it spawns, from `bridge.publicUrl`.
- Unset, the ship pins whichever bridge pushes to it first and holds that from
  then on. The pin lives in
  `~/.config/autosmith/fleet-ship/armory/state.json`.

The URL is compared as an origin — scheme, host, port, and path — so
`http://Bridge:4800/` and `http://bridge:4800` are the same bridge. Query strings
and case are ignored; a different port or host is a different bridge.

:::caution
Pinning is defence in depth, **not** authentication — it is about *which* server a
ship installs from, not *who* may ask it to. A ship started without
`FLEET_BRIDGE_TOKEN` has no authentication at all: anyone who can reach its port
can start workspaces and run commands on it, and pinning only removes the
armory's own contribution to that. Even a fully credentialed ship is reachable by
anyone holding its token, and tokens travel in a plain header. **Do not expose a
ship's port to a network you do not trust**; put ships on a private network or
behind a tunnel. See [authentication](/guides/authentication/).
:::

## Skills fan out to every provider

`skills/<name>/` is a standard skill directory — a `SKILL.md` plus whatever else
it needs. Each one is installed into every agent provider whose config directory
already exists on that ship:

| Provider | Skills directory |
| --- | --- |
| `claude-code` | `~/.claude/skills/<name>/` |
| `opencode` | `~/.config/opencode/skills/<name>/` |
| `copilot` | `~/.copilot/skills/<name>/` |
| `codex` | `~/.codex/skills/<name>/` and `~/.agents/skills/<name>/` |

So `skills/reviewer/SKILL.md` on a host with all four providers becomes five
files, `reviewer/SKILL.md` under each root above. Fleet never creates a config
root — a provider you have not installed is skipped, not conjured.

Codex gets the skill twice: in its own directory and in the shared `~/.agents`
location. That mirrors what a ship already does for its built-in `fleet-agent`
skill.

## Plugins pass straight through

Skills fan out because every provider understands the same skill format. Nothing
else does, so `plugins/` does not try. The path after the provider name is used
verbatim, relative to that provider's **config root**:

| Armory path | Lands at |
| --- | --- |
| `plugins/claude-code/commands/lint.md` | `~/.claude/commands/lint.md` |
| `plugins/opencode/plugins/notify.js` | `~/.config/opencode/plugins/notify.js` |
| `plugins/codex/config.toml` | `~/.codex/config.toml` |

You control the layout, which means you can install anything a provider reads,
not just the shapes Fleet knows about. It also means the path is your
responsibility: Fleet does not validate that `~/.claude/commands/` is a thing
claude-code reads.

The first segment must name a provider — `claude-code`, `opencode`, `copilot`,
or `codex`. Anything else is skipped with a warning:

```
ignored armory plugins/vscode: not a directory named after a known provider (claude-code, opencode, copilot, codex)
```

A *known* provider that simply isn't installed on that host is skipped silently.
That is the normal case, not a problem: one armory serves hosts with different
tools on them.

## Dotfiles are symlinked

`dotfiles/` holds files and directories; `dotfile-map.json` says where each one
goes. Sources are relative to `dotfiles/`; destinations are `~/`-rooted or
absolute:

```json
{
  "gitconfig": "~/.gitconfig",
  "nvim": "~/.config/nvim",
  "tmux.conf": "~/.tmux.conf"
}
```

Each mapping becomes a **symlink** at the destination pointing into the ship's
armory cache. Nothing is copied. A directory source is one symlink to the whole
directory — `nvim` above produces a single `~/.config/nvim` link, not a file per
entry — so adding a file to `dotfiles/nvim/` on the bridge makes it visible on
every ship without re-linking anything.

Symlinks are why edits propagate at all. The trade-off is that a tool which
rewrites its config in place is writing into the ship's cache, and the next sync
will overwrite it.

## Conflicts

A destination that already holds a real file, a real directory, or a symlink
pointing anywhere other than the armory cache is a **conflict**. Fleet leaves it
exactly as it is and reports the path:

```
orca:
  conflict: /home/you/.vimrc
```

The same rule covers skills and plugins: a file Fleet does not own, or one it
owned and you have since edited, is preserved and reported rather than replaced.

The ship also says so on its own console at startup, once per conflicting path:

```
Fleet startup preserved a conflicting dotfile: /home/you/.vimrc. Move or delete it to let the armory's symlink take that path on the next sync or ship restart.
```

A symlink that already points *into* the cache is not a conflict — Fleet made
it, so it is re-pointed without ceremony when the source moves.

:::caution
There is currently no way to force past an armory conflict. The installer has a
`force` option internally, but nothing user-facing sets it, and no CLI flag
exposes it. To resolve one, **move or delete** what is at the destination on that
ship. The next sync — or the ship's next restart, which re-applies the cache
without waiting for the bridge — links or writes over the now-empty path.

Note that `fleet ship plugin install --force` is a different subsystem — it
covers the built-in `fleet-agent` skill and startup plugins, not the armory.
:::

## Removal never clobbers your work

Delete something from the armory and the ships uninstall it — but only where
Fleet can still prove the file is the one it wrote.

For skills and plugins, proof is a content hash: Fleet records each installed
path's `sha256` and mode in `~/.config/autosmith/fleet-ship/managed-files-v1.json`
and re-checks both immediately before unlinking. Edit an installed file and it no
longer matches, so it stays:

```
warning: left /home/you/.claude/skills/reviewer/SKILL.md in place: it no longer matches what Fleet installed there
```

For dotfiles, proof is the link itself: the target must still be a symlink
pointing into the ship's armory cache. A target you have replaced with a real
file, or re-pointed elsewhere, is left alone and reported the same way.

Empty directories left behind by a removal are pruned, but never above the
provider's own root.

## Check what happened

From the CLI, against the bridge:

```bash
fleet client armory ls
fleet client armory cat skills/reviewer/SKILL.md
fleet client armory ships
```

`ls` lists what the bridge holds and the revision it is serving; `cat` prints one
file; `ships` is the one that answers "did it land?":

```
SHIP  STATUS  REVISION      SYNCED                    STATE
orca  online  59a0c6b293b4  2026-07-27T14:51:20.318Z  in sync

orca:
  conflict: /home/you/.vimrc
  warning: skipped dotfile bashrc: destination "/etc/bashrc" is outside /home/you
```

`STATE` is `in sync` when the ship holds the bridge's current revision, `behind`
when it holds an older one, `never` when it has never synced, `error` when its
last attempt failed, and `unknown` when the bridge could not reach it at all.
`error` outranks the revision comparison: a ship whose sync failed is stuck on a
revision it could not replace, and that is more useful to know than "behind".

The same view is in the GUI's [Armory page](/guides/web-gui/), which adds a file
viewer and the dotfile map. See the [CLI reference](/reference/cli/) for the full
flag list.

## Troubleshooting

**Nothing syncs at all, and no ship reports an error.** The bridge tells each
ship where to pull from, using `bridge.publicUrl` (or
`fleet bridge --public-url`). Unset, it defaults to `http://localhost:<port>` —
which on another host means that host. Set it to a URL your ships can reach. See
[multi-host](/guides/multi-host/).

**One ship reports `bridge answered 401 for the armory manifest`.** That ship has
no `shipToken`, so its pull reached the bridge with no credential. Restart it with
`FLEET_SHIP_TOKEN` set to the `shipToken` the bridge was given for it, and check
the two match. Nothing else about the ship is affected — its workspaces keep
working, which is why this is easy to miss until you look at
`fleet client armory ships`. `fleet launch` supplies the token to every
`source: local` ship it spawns, so this only affects ships you start yourself.
See [authentication](/guides/authentication/).

**`fleet client armory ls` returns a 400 naming `dotfile-map.json`.** A malformed
map fails the whole manifest, so nothing is served and nothing is pushed — ships
keep the last good revision. Every bad entry is listed at once, keyed by source:

```
fleet: request failed (400): invalid /srv/.fleet-bridge/armory/dotfile-map.json:
  "vimrc": destination "relative/path" must start with "~/" or be absolute
  "../evil": source "../evil" must be a relative path under dotfiles/ with no "..", "." or "\" segments
```

Sources must be relative paths under `dotfiles/` with no `.` or `..` segments;
destinations must start with `~/` or be absolute. A missing `dotfile-map.json` is
not an error — it means nothing is linked.

**A dotfile is reported as skipped rather than linked.** Destinations are
confined to the ship's home directory:

```
warning: skipped dotfile bashrc: destination "/etc/bashrc" is outside /home/you
```

The mapping is dropped, not attempted. Use a destination under the ship user's
home.

**A ship answers the push with `403` and never syncs.** It is pinned to a
different bridge, so it refused the push without fetching anything:

```
fleet-bridge: could not push the armory to ship "orca": armory push refused: this ship is pinned to bridge http://10.0.0.2:4800 but the push named http://10.0.0.9:4800; the pin is this ship's configured --bridge-url
```

The message names both URLs and where the pin came from. If the push is the
legitimate one, the two are out of step — usually `bridge.publicUrl` (or
`fleet bridge --public-url`) changed after the ship was pinned. Fix it by making
them agree: restart the ship with a matching `--bridge-url`, or, for a ship
pinned by first use rather than configuration, delete
`~/.config/autosmith/fleet-ship/armory/state.json` on that ship and let the next
push re-pin it. If the push is *not* one you sent, something else on the network
is pushing at your ships; see the caution above.

**A large file breaks the sync.** The bridge refuses to serve any single file
over 10 MiB. It still appears in the manifest, but fetching it answers `413`,
which fails that ship's whole sync and shows up as `error` in
`fleet client armory ships`. Keep binaries out of the armory.

## Related

- [Agent integrations](/guides/agent-integrations/) — the built-in `fleet-agent`
  skill, which is Fleet's own and separate from anything you put here.
- [Running across several machines](/guides/multi-host/) — why a multi-host fleet
  needs `bridge.publicUrl`.
- [Bridge API](/reference/bridge-api/) and [ship API](/reference/ship-api/) — the
  routes behind all of this.
</content>
</invoke>
