/**
 * scripts/build.ts
 *
 * Reproducible build for the libghostty-vt bun:ffi bindings.
 *
 * What it does, in order:
 *   1. Ensure a pinned Zig toolchain (downloads it locally if not on PATH).
 *   2. Fetch ghostty-org/ghostty at the PINNED commit into ./vendor/ghostty.
 *   3. Build libghostty-vt as a shared + static library:
 *          zig build -Demit-lib-vt=true
 *   4. Compile the thin C shim (shim/ghostty_vt_shim.c) into a shared object,
 *      dynamically linked against libghostty-vt with an $ORIGIN/@loader_path
 *      rpath, and copy both shared libraries into ./prebuilds.
 *
 * The output shim lib is named using bun:ffi's platform `suffix`
 * ("so"/"dylib"/"dll"), so the bindings can locate it at runtime.
 *
 * Run:  bun run scripts/build.ts
 */

import { suffix } from "bun:ffi";
import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- Pinned versions -------------------------------------------------------
// ghostty's libghostty-vt C API is NOT tagged/versioned and WILL change.
// Pin exactly and bump deliberately.
const PINNED_COMMIT = "8642142a3d62beda7b1a9733c23bf11b80c720eb";
const ZIG_VERSION = "0.15.2"; // ghostty build.zig.zon: minimum_zig_version

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor");
const GHOSTTY_DIR = join(VENDOR, "ghostty");
const PREBUILDS = join(ROOT, "prebuilds");
const SHIM_C = join(ROOT, "shim", "ghostty_vt_shim.c");
const SHIM_DIR = join(ROOT, "shim");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function log(msg: string) {
  console.log(`\x1b[36m[build]\x1b[0m ${msg}`);
}

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  log(`$ ${cmd.join(" ")}${opts.cwd ? `   (in ${opts.cwd})` : ""}`);
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
}

async function capture(cmd: string[], cwd = ROOT): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

// --- 1. Zig toolchain ------------------------------------------------------
async function ensureZig(): Promise<string> {
  // Honour an existing zig of the right version.
  try {
    const v = await capture(["zig", "version"]);
    if (v === ZIG_VERSION) {
      log(`using system zig ${v}`);
      return "zig";
    }
    log(`system zig is ${v}, need ${ZIG_VERSION}; using a local copy instead`);
  } catch {
    /* no zig on PATH */
  }

  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = IS_MAC ? "macos" : IS_WIN ? "windows" : "linux";
  const ext = IS_WIN ? "zip" : "tar.xz";
  const name = `zig-${arch}-${os}-${ZIG_VERSION}`;
  const dir = join(VENDOR, name);
  const zigBin = join(dir, IS_WIN ? "zig.exe" : "zig");

  if (existsSync(zigBin)) {
    log(`using local zig at ${zigBin}`);
    return zigBin;
  }

  mkdirSync(VENDOR, { recursive: true });
  const url = `https://ziglang.org/download/${ZIG_VERSION}/${name}.${ext}`;
  const archive = join(VENDOR, `zig.${ext}`);
  log(`downloading ${url}`);
  await run(["curl", "-fSL", url, "-o", archive]);
  log(`extracting ${name}`);
  if (IS_WIN) {
    await run(["tar", "-xf", archive], { cwd: VENDOR }); // bsdtar on win handles zip
  } else {
    await run(["tar", "-xf", archive], { cwd: VENDOR });
  }
  rmSync(archive, { force: true });
  if (!existsSync(zigBin)) throw new Error(`zig binary not found after extract: ${zigBin}`);
  return zigBin;
}

// --- 2. ghostty source at the pinned commit --------------------------------
async function ensureGhostty() {
  const gitDir = join(GHOSTTY_DIR, ".git");
  let atPinned = false;
  if (existsSync(gitDir)) {
    const head = await capture(["git", "rev-parse", "HEAD"], GHOSTTY_DIR).catch(() => "");
    const sparse = await capture(["git", "config", "core.sparseCheckout"], GHOSTTY_DIR).catch(() => "");
    atPinned = head === PINNED_COMMIT && sparse !== "true";
  }
  if (atPinned) {
    log(`ghostty already at pinned commit ${PINNED_COMMIT.slice(0, 12)}`);
    return;
  }

  mkdirSync(VENDOR, { recursive: true });
  if (!existsSync(gitDir)) {
    log(`initialising ghostty repo`);
    await run(["git", "init", "-q", GHOSTTY_DIR]);
    await run(["git", "-C", GHOSTTY_DIR, "remote", "add", "origin", "https://github.com/ghostty-org/ghostty.git"]);
  }
  // Make sure we have a full (non-sparse) working tree.
  await run(["git", "-C", GHOSTTY_DIR, "sparse-checkout", "disable"]).catch(() => {});
  log(`fetching pinned commit ${PINNED_COMMIT.slice(0, 12)} (shallow)`);
  await run(["git", "-C", GHOSTTY_DIR, "fetch", "--depth", "1", "origin", PINNED_COMMIT]);
  await run(["git", "-C", GHOSTTY_DIR, "checkout", "-q", "--force", PINNED_COMMIT]);
}

// --- 3. zig build ----------------------------------------------------------
async function buildVt(zig: string) {
  log(`building libghostty-vt (zig build -Demit-lib-vt=true) — this can take a few minutes`);
  await run([zig, "build", "-Demit-lib-vt=true", "-Doptimize=ReleaseFast"], { cwd: GHOSTTY_DIR });

  const libDir = join(GHOSTTY_DIR, "zig-out", "lib");
  const incDir = join(GHOSTTY_DIR, "zig-out", "include");
  if (!existsSync(incDir)) throw new Error(`missing headers at ${incDir}`);
  log(`zig-out/lib contents: ${readdirSync(libDir).join(", ")}`);
  return { libDir, incDir };
}

// --- 4. compile the shim ---------------------------------------------------
async function buildShim(libDir: string, incDir: string) {
  mkdirSync(PREBUILDS, { recursive: true });

  const cc = process.env.CC ?? (IS_MAC ? "clang" : "cc");
  const shimOut = join(PREBUILDS, `ghostty_vt_shim.${suffix}`);

  // libghostty-vt shared lib file name per platform.
  const vtLibName = IS_WIN ? "ghostty-vt.dll" : IS_MAC ? "libghostty-vt.dylib" : "libghostty-vt.so";
  const vtLibSrc = join(libDir, vtLibName);
  if (!existsSync(vtLibSrc)) {
    throw new Error(`expected shared lib not found: ${vtLibSrc}\n(have: ${readdirSync(libDir).join(", ")})`);
  }

  const rpath = IS_MAC ? "@loader_path" : "$ORIGIN";
  const args = [
    "-shared",
    "-fPIC",
    "-fvisibility=hidden",
    "-O2",
    `-I${incDir}`,
    `-I${SHIM_DIR}`,
    SHIM_C,
    `-L${libDir}`,
    "-lghostty-vt",
    "-o",
    shimOut,
  ];
  if (!IS_WIN) args.push(`-Wl,-rpath,${rpath}`);

  await run([cc, ...args]);

  // Place the vt shared lib(s) next to the shim so the rpath ($ORIGIN /
  // @loader_path) resolves the SONAME the shim links against. Zig emits a
  // versioned soname (e.g. libghostty-vt.so.0) plus symlinks, so copy every
  // matching shared-object variant and dereference symlinks to real files.
  const base = IS_WIN ? "ghostty-vt" : "libghostty-vt";
  const dropExts = [".a", ".lib", ".pdb"];
  const copied: string[] = [];
  for (const name of readdirSync(libDir)) {
    if (!name.startsWith(base)) continue;
    if (dropExts.some((e) => name.endsWith(e))) continue; // skip static/import libs
    const realSrc = realpathSync(join(libDir, name));
    copyFileSync(realSrc, join(PREBUILDS, name));
    copied.push(name);
  }
  if (copied.length === 0) throw new Error(`no shared vt lib copied from ${libDir}`);

  // libghostty-vt is MIT-licensed; when we redistribute the compiled binary in
  // the npm tarball we must ship its license/copyright notice alongside it.
  const licenseSrc = join(GHOSTTY_DIR, "LICENSE");
  if (existsSync(licenseSrc)) {
    copyFileSync(licenseSrc, join(PREBUILDS, "LICENSE-libghostty-vt"));
  }

  log(`\x1b[32m✓\x1b[0m shim:  ${shimOut}`);
  log(`\x1b[32m✓\x1b[0m vtlib: ${copied.join(", ")}`);
  return shimOut;
}

async function main() {
  const zig = await ensureZig();
  await ensureGhostty();
  const { libDir, incDir } = await buildVt(zig);
  await buildShim(libDir, incDir);
  log(`done. pinned ghostty commit: ${PINNED_COMMIT}`);
}

main().catch((err) => {
  console.error(`\x1b[31m[build] FAILED:\x1b[0m ${err.message}`);
  process.exit(1);
});
