// Fleet refuses to touch symlinks everywhere else (see managed-fs.ts, which
// manages regular files by content hash); this module is the sole exception,
// and only for links it can prove point inside the cache's `files/dotfiles/`.
// Do not route dotfiles through managed-fs, and do not weaken its checks to
// make that possible. The map is untrusted network input, so a destination must
// resolve strictly inside this ship's home directory.

import { lstat, mkdir, readlink, rename, rm, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isSafeArmoryPath, type DotfileMap } from "fleet-protocol";

export type DotfileLinkStatus = "linked" | "unchanged" | "relinked" | "conflict" | "skipped";

export type DotfileLink = {
  /** `dotfiles/`-relative, exactly as the map wrote it. */
  source: string;
  target: string;
  status: DotfileLinkStatus;
  /** Why, for `conflict` and `skipped`; what was replaced, for a forced link. */
  detail?: string;
};

export type DotfileLinkReport = {
  links: DotfileLink[];
  /** Absolute targets whose links this run deleted. */
  removed: string[];
  /** Absolute targets left alone because something unmanaged was already there. */
  conflicts: string[];
  warnings: string[];
};

export type LinkDotfilesOptions = {
  homeDirectory: string;
  cacheDirectory: string;
  dotfileMap: DotfileMap;
  force?: boolean;
};

/** `dotfiles.json`: the links the previous run put in place, so this one can undo them. */
const OwnedLinksSchema = z.object({
  version: z.literal(1),
  links: z.object({ target: z.string(), source: z.string() }).array(),
});

type OwnedLink = z.infer<typeof OwnedLinksSchema>["links"][number];

type PlannedLink = { source: string; target: string; sourcePath: string };

type Placement = { status: Exclude<DotfileLinkStatus, "skipped">; detail?: string };

export async function linkDotfiles(options: LinkDotfilesOptions): Promise<DotfileLinkReport> {
  const homeDirectory = resolve(options.homeDirectory);
  const cacheRoot = resolve(options.cacheDirectory);
  const dotfilesRoot = join(cacheRoot, "files", "dotfiles");
  const force = options.force ?? false;
  const report: DotfileLinkReport = { links: [], removed: [], conflicts: [], warnings: [] };

  const planned = await plan(homeDirectory, dotfilesRoot, options.dotfileMap, report);
  const failures: Error[] = [];
  const owned: OwnedLink[] = [];
  // Every target the map still names, conflicts included: a mapping that is in
  // the map is never a removal candidate, whatever came of it this run.
  const retained = new Set(planned.map((link) => link.target));

  for (const link of planned) {
    try {
      const placement = await place(link, dotfilesRoot, force);
      report.links.push({
        source: link.source,
        target: link.target,
        status: placement.status,
        ...(placement.detail === undefined ? {} : { detail: placement.detail }),
      });
      // A conflict means we wrote nothing, so claiming the target would make the
      // next run try to remove a link that is not ours.
      if (placement.status === "conflict") report.conflicts.push(link.target);
      else owned.push({ target: link.target, source: link.source });
    } catch (error) {
      failures.push(new Error(`Failed to link armory dotfile ${link.target}`, { cause: error }));
    }
  }

  for (const previous of await readOwnedLinks(cacheRoot, report.warnings)) {
    if (retained.has(previous.target)) continue;
    try {
      await unlinkOwned(previous.target, dotfilesRoot, report);
    } catch (error) {
      failures.push(
        new Error(`Failed to unlink armory dotfile ${previous.target}`, { cause: error }),
      );
    }
  }

  // Before the throw: links that did land are ours whether or not a sibling
  // mapping failed, and a record that omits them would orphan them forever.
  await writeOwnedLinks(cacheRoot, owned);

  if (failures.length > 0) throw new AggregateError(failures, "Failed to link the armory dotfiles");
  return report;
}

/** The mappings worth acting on; the rest are reported as `skipped` and dropped. */
async function plan(
  homeDirectory: string,
  dotfilesRoot: string,
  map: DotfileMap,
  report: DotfileLinkReport,
): Promise<PlannedLink[]> {
  const planned: PlannedLink[] = [];

  for (const [source, destination] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
    const skip = (target: string, detail: string) => {
      report.links.push({ source, target, status: "skipped", detail });
      report.warnings.push(`skipped dotfile ${source}: ${detail}`);
    };

    if (!destination.startsWith("~/") && !isAbsolute(destination)) {
      skip(destination, `destination "${destination}" is neither "~/"-rooted nor absolute`);
      continue;
    }
    const target = destination.startsWith("~/")
      ? resolve(homeDirectory, destination.slice(2))
      : resolve(destination);
    if (!isSafeArmoryPath(source)) {
      skip(target, `"${source}" is not a safe path under dotfiles/`);
      continue;
    }
    if (!isStrictDescendant(homeDirectory, target)) {
      skip(target, `destination "${destination}" is outside ${homeDirectory}`);
      continue;
    }
    const sourcePath = join(dotfilesRoot, ...source.split("/"));
    if (!(await entry(sourcePath))) {
      skip(target, `dotfiles/${source} is not in the armory cache`);
      continue;
    }
    planned.push({ source, target, sourcePath });
  }
  return planned;
}

async function place(
  link: PlannedLink,
  dotfilesRoot: string,
  force: boolean,
): Promise<Placement> {
  const current = await entry(link.target);
  if (!current) {
    await mkdir(dirname(link.target), { recursive: true });
    await placeLink(link.target, link.sourcePath);
    return { status: "linked" };
  }

  if (current.isSymbolicLink()) {
    const existing = resolve(dirname(link.target), await readlink(link.target));
    if (existing === link.sourcePath) return { status: "unchanged" };
    if (isStrictDescendant(dotfilesRoot, existing)) {
      await placeLink(link.target, link.sourcePath);
      return { status: "relinked" };
    }
    if (!force) return { status: "conflict", detail: `a symlink to ${existing} is already there` };
    await placeLink(link.target, link.sourcePath);
    return { status: "linked", detail: `replaced a symlink to ${existing}` };
  }

  const what = current.isDirectory() ? "directory" : "file";
  if (!force) return { status: "conflict", detail: `a ${what} is already there` };
  // `rename` cannot replace a directory, so this is the one case that leaves the
  // target briefly missing; everything else swaps in atomically.
  if (current.isDirectory()) await rm(link.target, { recursive: true, force: true });
  await placeLink(link.target, link.sourcePath);
  return { status: "linked", detail: `replaced a ${what}` };
}

/**
 * Point `target` at `source`. Written to a temporary name in the target's own
 * directory and renamed over it, because `symlink(2)` refuses an existing path
 * and unlinking first would leave the dotfile missing in between.
 */
async function placeLink(target: string, source: string): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.fleet-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    await symlink(source, temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove a target this cache recorded, unless it stopped being ours. */
async function unlinkOwned(
  target: string,
  dotfilesRoot: string,
  report: DotfileLinkReport,
): Promise<void> {
  const current = await entry(target);
  if (!current) return;
  if (!current.isSymbolicLink()) {
    report.warnings.push(`left ${target} in place: it is no longer a Fleet dotfile symlink`);
    return;
  }
  const existing = resolve(dirname(target), await readlink(target));
  if (!isStrictDescendant(dotfilesRoot, existing)) {
    report.warnings.push(`left ${target} in place: it now points at ${existing}`);
    return;
  }
  // Only the link itself. A parent directory existing is no evidence Fleet
  // created it, and the blast radius of being wrong is the user's home.
  await unlink(target);
  report.removed.push(target);
}

/** `lstat`, never `stat`: whether the target *is* a link is the whole question. */
async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function ownedLinksPath(cacheRoot: string): string {
  return join(cacheRoot, "dotfiles.json");
}

async function readOwnedLinks(cacheRoot: string, warnings: string[]): Promise<OwnedLink[]> {
  const path = ownedLinksPath(cacheRoot);
  let parsed: unknown;
  try {
    parsed = await Bun.file(path).json();
  } catch (error) {
    // A first run has no record; an unreadable one must not block linking, but
    // it does mean this run cannot undo what the last one linked.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`ignored unreadable ${path}: previously linked dotfiles cannot be removed`);
    }
    return [];
  }
  const record = OwnedLinksSchema.safeParse(parsed);
  if (!record.success) {
    warnings.push(`ignored invalid ${path}: previously linked dotfiles cannot be removed`);
    return [];
  }
  return record.data.links;
}

async function writeOwnedLinks(cacheRoot: string, links: OwnedLink[]): Promise<void> {
  const path = ownedLinksPath(cacheRoot);
  const body = `${JSON.stringify({ version: 1, links }, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(cacheRoot, { recursive: true });
    await Bun.write(temporary, body);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isStrictDescendant(root: string, target: string): boolean {
  const within = relative(root, target);
  return within !== "" && !within.startsWith("..") && !within.startsWith(sep) && !isAbsolute(within);
}
