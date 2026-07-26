/**
 * armory/armory-watcher.ts — notices that the bridge's `armory/` directory
 * changed and says so, once.
 *
 * The armory is hand-edited or `git pull`ed, so a single logical change arrives
 * as a burst of filesystem events; the debounce collapses that burst into one
 * callback, which is what keeps a `git pull` from fanning a push per file out
 * to every ship in the fleet.
 *
 * Nothing here may take the bridge down. The armory is optional, so a missing
 * directory yields a silent no-op handle, and a watch error is logged and
 * swallowed — a bridge that cannot watch its armory still routes workspaces.
 */

import { watch } from "node:fs";

const DEFAULT_DEBOUNCE_MS = 250;

export interface ArmoryWatcher {
  close(): void;
}

export function watchArmory(
  directory: string,
  onChange: () => void,
  options?: { debounceMs?: number; watch?: typeof watch },
): ArmoryWatcher {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const watchImpl = options?.watch ?? watch;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watchImpl(directory, { recursive: true }, () => {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          onChange();
        } catch (error) {
          console.warn(`fleet-bridge: armory change handler failed: ${message(error)}`);
        }
      }, debounceMs);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      console.warn(`fleet-bridge: not watching the armory at ${directory}: ${message(error)}`);
    }
    return { close: () => {} };
  }

  let reported = false;
  watcher.on("error", (error) => {
    // Once: an unwatchable directory can emit an error per event.
    if (reported) return;
    reported = true;
    console.warn(`fleet-bridge: armory watch on ${directory} failed: ${message(error)}`);
  });

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      try {
        watcher.close();
      } catch {
        // already closed
      }
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
