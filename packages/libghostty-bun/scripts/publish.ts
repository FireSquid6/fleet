/**
 * scripts/publish.ts — guarded npm release helper.
 *
 * SAFE BY DEFAULT: without an explicit --publish (or --yes) flag this only does
 * a `npm publish --dry-run` so you can review exactly what would be sent.
 *
 * Usage:
 *   bun run scripts/publish.ts                 # dry run (no changes, no upload)
 *   bun run scripts/publish.ts --publish       # publish current version
 *   bun run scripts/publish.ts patch --publish # bump patch, tag, then publish
 *   bun run scripts/publish.ts 0.2.0 --publish # set explicit version, then publish
 *
 * Flags:
 *   --publish, --yes     actually publish (otherwise dry-run)
 *   --allow-dirty        skip the clean-git-tree check
 *   --tag <dist-tag>     npm dist-tag (default: latest)
 *   --otp <code>         npm one-time password (2FA)
 *
 * 2FA / one-time password: if your npm account requires an OTP and you don't
 * pass --otp, the script prompts for it interactively just before uploading
 * (so the time-limited code is still fresh) and passes it to `npm publish`.
 *
 * The heavy pre-publish gate (build native + typecheck + tests) runs via the
 * package's `prepublishOnly` hook, so it applies to every publish path.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPkg(): { name: string; version: string; private?: boolean } {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const valueOf = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const doPublish = has("--publish") || has("--yes");
const allowDirty = has("--allow-dirty");
const distTag = valueOf("--tag");
const otpArg = valueOf("--otp");

// The first positional arg (not starting with "-" and not a flag value) is the
// optional version bump.
const flagValues = new Set([distTag, otpArg].filter(Boolean) as string[]);
const bump = argv.find((a) => !a.startsWith("-") && !flagValues.has(a));

const BUMP_KEYWORDS = new Set([
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
]);

function sh(cmd: string[], opts: { capture?: boolean } = {}): string {
  const r = Bun.spawnSync(cmd, {
    cwd: ROOT,
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
  });
  if (!r.success) {
    if (opts.capture && r.stderr) process.stderr.write(r.stderr);
    throw new Error(`command failed: ${cmd.join(" ")}`);
  }
  return opts.capture ? (r.stdout?.toString().trim() ?? "") : "";
}

function trySh(cmd: string[]): string | null {
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return r.success ? (r.stdout?.toString().trim() ?? "") : null;
}

/**
 * Prompt interactively for an npm one-time password (2FA/OTP). Called only when
 * actually publishing and no --otp was passed. Throws if there's no interactive
 * stdin or nothing was entered.
 */
function promptOtp(): string {
  if (!process.stdin.isTTY) {
    throw new Error(
      "an OTP is required but stdin is not interactive — re-run with --otp <code>",
    );
  }
  // Bun's global prompt() reads a line synchronously from the TTY.
  const code = prompt("npm one-time password (2FA OTP):");
  const trimmed = code?.trim() ?? "";
  if (!trimmed) {
    throw new Error("no OTP entered — aborting (re-run with --otp <code>)");
  }
  return trimmed;
}

function main() {
  const pkg = readPkg();
  console.log(`\x1b[36m[publish]\x1b[0m ${pkg.name}@${pkg.version}  (mode: ${doPublish ? "PUBLISH" : "dry-run"})`);

  if (pkg.private) {
    throw new Error(`package.json has "private": true — cannot publish. Remove it first.`);
  }

  if (bump && !BUMP_KEYWORDS.has(bump) && !/^\d+\.\d+\.\d+/.test(bump)) {
    throw new Error(`unrecognised version bump "${bump}" (use patch|minor|major|prerelease|<x.y.z>)`);
  }

  // --- preflight -----------------------------------------------------------
  const whoami = trySh(["npm", "whoami"]);
  if (whoami) {
    console.log(`[publish] npm user: ${whoami}`);
  } else if (doPublish) {
    throw new Error(`not logged in to npm — run \`npm login\` first`);
  } else {
    console.log(`[publish] (not logged in to npm; fine for a dry run)`);
  }

  if (doPublish && bump && !allowDirty) {
    const status = trySh(["git", "status", "--porcelain"]);
    if (status) {
      throw new Error(
        `git tree is dirty; \`npm version ${bump}\` needs a clean tree.\n` +
          `Commit/stash changes, or pass --allow-dirty to skip this check.`,
      );
    }
  }

  // --- version bump (creates a commit + tag) -------------------------------
  if (bump) {
    if (doPublish) {
      console.log(`[publish] bumping version: npm version ${bump}`);
      sh(["npm", "version", bump]);
      console.log(`[publish] new version: ${readPkg().version}`);
    } else {
      console.log(`[publish] (dry run) would run: npm version ${bump}`);
    }
  }

  // --- publish -------------------------------------------------------------
  // Resolve the OTP last, right before uploading: prefer --otp, otherwise prompt
  // interactively (only when actually publishing) so the time-limited code is
  // still fresh when npm uses it.
  let otp = otpArg;
  if (doPublish && !otp) {
    otp = promptOtp();
  }

  const publishCmd = ["npm", "publish", "--access", "public"];
  if (distTag) publishCmd.push("--tag", distTag);
  if (otp) publishCmd.push("--otp", otp);
  if (!doPublish) publishCmd.push("--dry-run");

  // Don't print the OTP in the echoed command.
  const shown = publishCmd.map((a, i) => (publishCmd[i - 1] === "--otp" ? "******" : a));
  console.log(`[publish] $ ${shown.join(" ")}`);
  sh(publishCmd);

  if (doPublish) {
    console.log(`\n\x1b[32m[publish] done.\x1b[0m`);
    if (bump) console.log(`Next: git push --follow-tags`);
  } else {
    console.log(
      `\n[publish] dry run complete — nothing was uploaded.\n` +
        `Re-run with --publish to release for real.`,
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`\x1b[31m[publish] ${(err as Error).message}\x1b[0m`);
  process.exit(1);
}
