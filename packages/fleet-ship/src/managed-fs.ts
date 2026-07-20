/**
 * managed-fs.ts — filesystem helpers shared by the skill and plugin installers.
 *
 * Both installers drop files into directories under a provider's config root
 * (e.g. `~/.claude/skills`). They must be idempotent and must never follow a
 * symlink or clobber something a user manages by hand, so these helpers refuse
 * to touch anything that isn't a plain file/directory we created ourselves.
 */

import { lstat, mkdir, stat } from "node:fs/promises";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** `mkdir` a directory we manage, refusing to follow a symlink or clobber a non-directory. */
export async function ensureManagedDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing to use non-directory path: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path);
  }
}

export type WriteStatus = "installed" | "updated" | "unchanged";

/**
 * Write `source` to `destination` idempotently, refusing to write through a
 * symlink or over a non-file. Returns whether the file was created (`installed`),
 * rewritten (`updated`), or already matched `source` (`unchanged`).
 */
export async function syncManagedFile(destination: string, source: string): Promise<WriteStatus> {
  let previous: string | undefined;
  try {
    const entry = await lstat(destination);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Refusing to replace non-file path: ${destination}`);
    }
    previous = await Bun.file(destination).text();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (previous === source) return "unchanged";
  await Bun.write(destination, source);
  return previous === undefined ? "installed" : "updated";
}

/**
 * Read-only counterpart to a config root + file check:
 *   - `absent`  — the provider's config root doesn't exist (harness not installed)
 *   - `missing` — config root exists but the file hasn't been installed
 *   - `stale`   — installed, but its contents differ from `source`
 *   - `current` — installed and byte-for-byte equal to `source`
 */
export type PresenceState = "absent" | "missing" | "stale" | "current";

/** Inspect a single managed file without writing. `absent` is reported by callers. */
export async function inspectManagedFile(
  destination: string,
  source: string,
): Promise<Exclude<PresenceState, "absent">> {
  try {
    return (await Bun.file(destination).text()) === source ? "current" : "stale";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}
