import { lstat, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isSafeArmoryPath } from "fleet-protocol";
import {
  ensureSafeDirectory,
  isDirectory,
  withManagedFiles,
  type WriteStatus,
} from "../managed-fs";
import {
  PROVIDERS,
  configRootFor,
  isProvider,
  skillRootsFor,
  type Provider,
} from "../providers";
import { armoryCacheDirectory, cachedDotfileMap } from "./armory-cache";
import { linkDotfiles, type DotfileLink } from "./dotfile-linker";

export type ArmoryInstallOptions = {
  homeDirectory?: string;
  cacheDirectory?: string;
  force?: boolean;
};

export type ArmoryInstallReport = {
  skills: { skill: string; provider: Provider; path: string; status: WriteStatus }[];
  plugins: { provider: Provider; path: string; status: WriteStatus }[];
  dotfiles: DotfileLink[];
  removed: string[];
  /** Destinations left alone because an unmanaged file was already there. */
  conflicts: string[];
  warnings: string[];
};

/** `installed.json`: what the previous run put on disk, so this one can undo it. */
const InstalledRecordSchema = z.object({
  version: z.literal(1),
  files: z
    .object({
      path: z.string(),
      provider: z.string(),
      kind: z.enum(["skill", "plugin"]),
    })
    .array(),
});

type InstalledEntry = z.infer<typeof InstalledRecordSchema>["files"][number];

type PresentProvider = { provider: Provider; configRoot: string; skillRoots: string[] };

type PlannedFile = {
  source: string;
  destination: string;
  mode: number;
  provider: Provider;
} & ({ kind: "skill"; skill: string } | { kind: "plugin" });

export async function installArmory(
  options: ArmoryInstallOptions = {},
): Promise<ArmoryInstallReport> {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const cacheRoot = options.cacheDirectory
    ? resolve(options.cacheDirectory)
    : armoryCacheDirectory(homeDirectory);
  const report: ArmoryInstallReport = {
    skills: [],
    plugins: [],
    dotfiles: [],
    removed: [],
    conflicts: [],
    warnings: [],
  };

  const filesRoot = join(cacheRoot, "files");
  // A ship that has never synced has nothing to install and nothing to undo.
  if (!(await isDirectory(filesRoot))) return report;

  const present: PresentProvider[] = [];
  for (const provider of PROVIDERS) {
    const configRoot = configRootFor(homeDirectory, provider);
    if (await isDirectory(configRoot)) {
      present.push({ provider, configRoot, skillRoots: skillRootsFor(homeDirectory, provider) });
    }
  }

  const planned = [
    ...(await planSkills(filesRoot, present, report.warnings)),
    ...(await planPlugins(filesRoot, present, report.warnings)),
  ].sort((a, b) => a.destination.localeCompare(b.destination));

  const plannedPaths = new Set(planned.map((file) => file.destination));
  const stale = (await readInstalledRecord(cacheRoot, report.warnings)).filter(
    (entry) => !plannedPaths.has(entry.path),
  );

  const installed: InstalledEntry[] = [];
  const failures: Error[] = [];

  await withManagedFiles(homeDirectory, async (session) => {
    const ensured = new Set<string>();
    for (const file of planned) {
      try {
        const directory = dirname(file.destination);
        if (!ensured.has(directory)) {
          await ensureSafeDirectory(homeDirectory, directory);
          ensured.add(directory);
        }
        const status = await session.sync(file.destination, await Bun.file(file.source).bytes(), {
          provider: file.provider,
          kind: file.kind,
          force: options.force ?? false,
          mode: file.mode,
        });
        if (file.kind === "skill") {
          report.skills.push({
            skill: file.skill,
            provider: file.provider,
            path: file.destination,
            status,
          });
        } else {
          report.plugins.push({ provider: file.provider, path: file.destination, status });
        }
        // A conflict means we wrote nothing, so claiming ownership of the
        // destination would make the next run try to uninstall a file that is
        // not ours.
        if (status === "conflict") report.conflicts.push(file.destination);
        else installed.push({ path: file.destination, provider: file.provider, kind: file.kind });
      } catch (error) {
        failures.push(
          new Error(`Failed to install armory file ${file.destination}`, { cause: error }),
        );
      }
    }

    for (const entry of stale) {
      try {
        const outcome = await session.remove(entry.path, {
          provider: entry.provider,
          kind: entry.kind,
        });
        if (outcome === "removed") report.removed.push(entry.path);
        else if (outcome === "not-owned") {
          report.warnings.push(
            `left ${entry.path} in place: it no longer matches what Fleet installed there`,
          );
        }
      } catch (error) {
        failures.push(
          new Error(`Failed to uninstall armory file ${entry.path}`, { cause: error }),
        );
      }
    }
  });

  for (const path of report.removed) {
    await pruneEmptyDirectories(homeDirectory, boundaryFor(homeDirectory, path), path);
  }
  await writeInstalledRecord(cacheRoot, installed);

  // Third phase, after the copied files: the map comes from the cache's own
  // state, so a ship installs exactly the map that arrived with the revision it
  // pulled and never re-asks the bridge.
  try {
    const dotfiles = await linkDotfiles({
      homeDirectory,
      cacheDirectory: cacheRoot,
      dotfileMap: await cachedDotfileMap(cacheRoot),
      force: options.force,
    });
    report.dotfiles = dotfiles.links;
    report.removed.push(...dotfiles.removed);
    report.conflicts.push(...dotfiles.conflicts);
    report.warnings.push(...dotfiles.warnings);
  } catch (error) {
    // Flattened rather than wrapped: an `AggregateError`'s own message names no
    // path, and callers render the individual failures.
    if (error instanceof AggregateError) {
      failures.push(...error.errors.map(asError));
    } else {
      failures.push(new Error("Failed to link the armory dotfiles", { cause: error }));
    }
  }

  if (failures.length > 0) throw new AggregateError(failures, "Failed to install the armory");
  return report;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function planSkills(
  filesRoot: string,
  present: PresentProvider[],
  warnings: string[],
): Promise<PlannedFile[]> {
  const skillsRoot = join(filesRoot, "skills");
  const planned: PlannedFile[] = [];

  for (const entry of await sectionEntries(skillsRoot)) {
    if (!entry.isDirectory()) {
      warnings.push(`ignored armory skills/${entry.name}: a skill must be a directory`);
      continue;
    }
    if (!isSafeArmoryPath(entry.name)) {
      warnings.push(`ignored armory skill ${entry.name}: unsafe name`);
      continue;
    }
    const source = join(skillsRoot, entry.name);
    for (const { path, mode } of await treeFiles(source, `skills/${entry.name}`, warnings)) {
      for (const provider of present) {
        for (const skillRoot of provider.skillRoots) {
          planned.push({
            source: join(source, ...path.split("/")),
            destination: join(skillRoot, entry.name, ...path.split("/")),
            mode,
            provider: provider.provider,
            kind: "skill",
            skill: entry.name,
          });
        }
      }
    }
  }
  return planned;
}

async function planPlugins(
  filesRoot: string,
  present: PresentProvider[],
  warnings: string[],
): Promise<PlannedFile[]> {
  const pluginsRoot = join(filesRoot, "plugins");
  const planned: PlannedFile[] = [];

  for (const entry of await sectionEntries(pluginsRoot)) {
    if (!entry.isDirectory() || !isProvider(entry.name)) {
      warnings.push(
        `ignored armory plugins/${entry.name}: not a directory named after a known provider (${PROVIDERS.join(", ")})`,
      );
      continue;
    }
    // Not a warning: a provider this host does not use is the normal case.
    const provider = present.find((candidate) => candidate.provider === entry.name);
    if (!provider) continue;

    const source = join(pluginsRoot, entry.name);
    for (const { path, mode } of await treeFiles(source, `plugins/${entry.name}`, warnings)) {
      planned.push({
        source: join(source, ...path.split("/")),
        destination: join(provider.configRoot, ...path.split("/")),
        mode,
        provider: provider.provider,
        kind: "plugin",
      });
    }
  }
  return planned;
}

/** A section's directory entries; an absent section is simply empty. */
async function sectionEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Every regular file under `directory`, as `/`-separated relative paths with
 * the mode to install them with. Cached bytes are still untrusted input, so
 * each path is re-validated and only the executable bit is carried over.
 */
async function treeFiles(
  directory: string,
  label: string,
  warnings: string[],
): Promise<{ path: string; mode: number }[]> {
  const files: { path: string; mode: number }[] = [];
  for await (const found of new Bun.Glob("**/*").scan({
    cwd: directory,
    dot: true,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    const path = found.split(sep).join("/");
    if (!isSafeArmoryPath(path)) {
      warnings.push(`ignored armory file ${label}/${path}: unsafe path`);
      continue;
    }
    const stats = await lstat(join(directory, ...path.split("/")));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      warnings.push(`ignored armory file ${label}/${path}: not a regular file`);
      continue;
    }
    files.push({ path, mode: (stats.mode & 0o111) === 0 ? 0o644 : 0o755 });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The directory an uninstalled file's now-empty parents may be pruned up to,
 * exclusive: a provider's own skills root or config root, never past it.
 * Returns `""` — pruning nothing — for a path we cannot place.
 */
function boundaryFor(homeDirectory: string, path: string): string {
  for (const provider of PROVIDERS) {
    for (const root of [...skillRootsFor(homeDirectory, provider), configRootFor(homeDirectory, provider)]) {
      if (isStrictDescendant(root, path)) return root;
    }
  }
  return "";
}

/** Delete directories emptied by an uninstall, from `path`'s parent up to `boundary`. */
async function pruneEmptyDirectories(
  homeDirectory: string,
  boundary: string,
  path: string,
): Promise<void> {
  if (boundary === "") return;
  let current = dirname(path);
  while (isStrictDescendant(boundary, current) && isStrictDescendant(homeDirectory, current)) {
    try {
      await rmdir(current);
    } catch (error) {
      // ENOTEMPTY means something else lives here and everything above it stays.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    current = dirname(current);
  }
}

function isStrictDescendant(root: string, target: string): boolean {
  const within = relative(root, target);
  return within !== "" && !within.startsWith("..") && !within.startsWith(sep);
}

function installedRecordPath(cacheRoot: string): string {
  return join(cacheRoot, "installed.json");
}

async function readInstalledRecord(
  cacheRoot: string,
  warnings: string[],
): Promise<InstalledEntry[]> {
  const path = installedRecordPath(cacheRoot);
  let parsed: unknown;
  try {
    parsed = await Bun.file(path).json();
  } catch (error) {
    // A first run has no record; a corrupt one must not block installing, but
    // it does mean this run cannot uninstall what the last one wrote.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`ignored unreadable ${path}: previously installed files cannot be removed`);
    }
    return [];
  }
  const record = InstalledRecordSchema.safeParse(parsed);
  if (!record.success) {
    warnings.push(`ignored invalid ${path}: previously installed files cannot be removed`);
    return [];
  }
  return record.data.files;
}

async function writeInstalledRecord(cacheRoot: string, files: InstalledEntry[]): Promise<void> {
  const path = installedRecordPath(cacheRoot);
  const body = `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await Bun.write(temporary, body);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
