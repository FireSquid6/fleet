import type { ArmoryInstallSummary, ArmorySyncRequest, ArmorySyncState } from "fleet-protocol";
import { ArmoryCache, ArmorySyncError } from "./armory-cache";
import { installArmory, type ArmoryInstallReport } from "./armory-installer";

export type SyncAndInstallOptions = {
  force?: boolean;
  /** Swappable for tests; production always installs from the cache just pulled. */
  install?: typeof installArmory;
};

export async function syncAndInstall(
  cache: ArmoryCache,
  request: ArmorySyncRequest,
  options: SyncAndInstallOptions = {},
): Promise<ArmorySyncState> {
  await cache.sync(request);

  const install = options.install ?? installArmory;
  let report: ArmoryInstallReport;
  try {
    report = await install({
      homeDirectory: cache.homeDirectory,
      cacheDirectory: cache.cacheDirectory,
      force: options.force,
    });
  } catch (error) {
    const detail = describe(error);
    await cache.recordInstall(null, `armory install failed: ${detail}`).catch(() => {});
    // 500: the pull worked, so this is the ship's own filesystem, not the bridge's.
    throw new ArmorySyncError(`armory install failed: ${detail}`, 500);
  }

  return cache.recordInstall(summarize(report));
}

export function summarize(report: ArmoryInstallReport): ArmoryInstallSummary {
  return {
    skillCount: report.skills.length,
    pluginCount: report.plugins.length,
    dotfileCount: report.dotfiles.filter(({ status }) => status !== "conflict" && status !== "skipped")
      .length,
    removedCount: report.removed.length,
    conflicts: report.conflicts,
    warnings: report.warnings,
    installedAt: new Date().toISOString(),
  };
}

/** Flatten an `AggregateError` from the installer: its own message names nothing. */
function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map((failure) => describe(failure)).join("; ");
  }
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
