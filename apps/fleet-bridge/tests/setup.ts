/**
 * Bun test preload: rebuild the ephemeral migrations from an empty database so every
 * test run starts from a clean schema. `drizzle/ephemeral` is gitignored and never
 * hand-maintained — it is derived here from `src/db/schema.ts`.
 *
 * Registered as `[test] preload` in fleet-bridge's `bunfig.toml`, so it runs on every
 * `bun test` for this app (directly or via the root `--filter` fan-out).
 */
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

rmSync(join(appDir, "drizzle/ephemeral"), { recursive: true, force: true });

const gen = Bun.spawnSync(
  ["bunx", "drizzle-kit", "generate", "--config", "drizzle-configs/ephemeral.config.ts"],
  { cwd: appDir, stdout: "pipe", stderr: "pipe" },
);
if (gen.exitCode !== 0) {
  throw new Error(
    `failed to regenerate ephemeral drizzle migrations:\n${gen.stderr.toString()}${gen.stdout.toString()}`,
  );
}
