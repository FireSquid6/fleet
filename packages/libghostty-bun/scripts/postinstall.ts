/**
 * scripts/postinstall.ts
 *
 * Runs on `npm install` / `bun install`. If the published tarball already
 * contains a prebuilt shim for this platform (the common case — same OS/arch as
 * the publisher), this is a no-op. Otherwise it builds libghostty-vt from source
 * (downloads Zig, fetches the pinned ghostty commit, compiles the shim).
 *
 * Guards:
 *   - Skipped entirely when LIBGHOSTTY_BUN_SKIP_POSTINSTALL is set.
 *   - Skipped in a dev checkout of this repo (i.e. when NOT installed under a
 *     node_modules/ tree). Contributors run `bun run build` explicitly instead,
 *     so a bare `bun install` never kicks off a multi-minute source build.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNative, nativeReady, SHIM_PATH } from "./ensure-native";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.LIBGHOSTTY_BUN_SKIP_POSTINSTALL) {
  console.log("[postinstall] skipped (LIBGHOSTTY_BUN_SKIP_POSTINSTALL is set).");
  process.exit(0);
}

// When this package is a dependency it lives under a node_modules/ directory.
// When it's the project being developed, it does not — skip auto-building then.
const installedAsDependency = ROOT.split(/[\\/]+/).includes("node_modules");
if (!installedAsDependency) {
  console.log("[postinstall] dev checkout detected — skipping auto-build (run `bun run build`).");
  process.exit(0);
}

if (nativeReady()) {
  console.log(`[postinstall] prebuilt native library present (${SHIM_PATH}).`);
  process.exit(0);
}

try {
  ensureNative();
  console.log("[postinstall] native library built successfully.");
} catch (err) {
  console.error(`\n[postinstall] failed to build the native library: ${(err as Error).message}`);
  console.error(
    "This package builds libghostty-vt from source when no prebuilt binary matches your\n" +
      "platform. That needs: git, a C compiler (cc/clang), and network access.\n" +
      "Set LIBGHOSTTY_BUN_SKIP_POSTINSTALL=1 to skip this step (the package will not work\n" +
      "until the native library is built with `bun run build`).",
  );
  process.exit(1);
}
