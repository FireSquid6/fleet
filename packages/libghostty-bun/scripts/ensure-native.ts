/**
 * scripts/ensure-native.ts
 *
 * Idempotent guard: make sure a native shim for THIS platform exists in
 * ./prebuilds, building it from source only if it's missing. Shared by the
 * postinstall hook and the pack/publish lifecycle.
 *
 *   bun run scripts/ensure-native.ts
 */

import { suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Path to the compiled shim for the current platform. */
export const SHIM_PATH = join(ROOT, "prebuilds", `ghostty_vt_shim.${suffix}`);

/** True if a prebuilt shim for the current platform is already present. */
export function nativeReady(): boolean {
  return existsSync(SHIM_PATH);
}

/**
 * Ensure the native library is built. No-op if a matching prebuilt exists,
 * otherwise runs the full source build (scripts/build.ts). Throws on failure.
 */
export function ensureNative(): void {
  if (nativeReady()) return;

  console.log(
    `[ensure-native] no prebuilt "${`ghostty_vt_shim.${suffix}`}" for this platform — building from source…`,
  );
  const result = Bun.spawnSync(["bun", "run", join(ROOT, "scripts", "build.ts")], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) {
    throw new Error("native build failed (see output above)");
  }
  if (!nativeReady()) {
    throw new Error(`build completed but ${SHIM_PATH} is still missing`);
  }
}

if (import.meta.main) {
  ensureNative();
  console.log(`[ensure-native] ready: ${SHIM_PATH}`);
}
