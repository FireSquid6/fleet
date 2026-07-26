/**
 * armory/armory-service.ts — scans `<dataDirectory>/armory` into a content-addressed
 * `ArmoryManifest` and serves individual files out of it.
 *
 * Read-only and human-authored: the directory is hand-edited or git-synced, so the
 * scan is defensive rather than trusting. Symlinks are skipped outright (never
 * followed, never listed) because a symlink in the armory would let a manifest
 * consumer pull a file from anywhere on the bridge host, and the rest of this
 * codebase refuses symlinks for the same reason.
 *
 * The manifest is the single source of truth: `readFile` only serves paths the
 * manifest lists, which is what confines reads to the three section directories.
 * A scan is cached until `invalidate()` (a filesystem watcher calls it) and
 * serialized through a promise queue, mirroring `store.ts`, so concurrent
 * requests never walk the tree simultaneously.
 */

import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  ARMORY_SECTIONS,
  ArmoryManifestSchema,
  DOTFILE_MAP_FILENAME,
  DotfileMapSchema,
  isSafeArmoryPath,
  type ArmoryEntry,
  type ArmoryFile,
  type ArmoryManifest,
  type ArmorySection,
  type DotfileMap,
} from "fleet-protocol";

/** Ceiling on a single `readFile`; oversized files are still listed in the manifest. */
export const MAX_ARMORY_FILE_BYTES = 10 * 1024 * 1024;

/** Names never worth shipping, skipped wherever they appear in the tree. */
const IGNORED_NAMES = new Set([".git", ".DS_Store"]);

export class ArmoryPathError extends Error {
  constructor(readonly path: string) {
    super(`unsafe armory path: ${path}`);
    this.name = "ArmoryPathError";
  }
}

export class ArmoryNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`armory file not found: ${path}`);
    this.name = "ArmoryNotFoundError";
  }
}

export class ArmoryTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
  ) {
    super(`armory file too large (${size} bytes, limit ${MAX_ARMORY_FILE_BYTES}): ${path}`);
    this.name = "ArmoryTooLargeError";
  }
}

/**
 * A `dotfile-map.json` a human has to go and fix. `message` names the absolute
 * file and every offending entry, because it travels to the HTTP client through
 * `BridgeError` and is the whole of what a `curl` or CLI user gets to debug with.
 */
export class ArmoryMapError extends Error {
  constructor(
    /** Absolute path of the offending file — the operator may not know where `dataDirectory` resolved to. */
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`invalid ${file}:\n  ${problems.join("\n  ")}`);
    this.name = "ArmoryMapError";
  }
}

export class ArmoryService {
  private cached: ArmoryManifest | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly root: string;

  constructor(armoryDirectory: string) {
    this.root = resolve(armoryDirectory);
  }

  private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The current manifest, scanning only when the cache is cold. */
  async manifest(): Promise<ArmoryManifest> {
    return this.serialized(async () => {
      if (this.cached) return this.cached;
      this.cached = await this.scan();
      return this.cached;
    });
  }

  /** Drop the cached manifest so the next `manifest()` rescans. */
  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * One file's contents plus the facts the manifest reports for it. The size,
   * hash, and mode come from the manifest rather than a fresh stat so a consumer
   * that verifies against the manifest sees a consistent pair; an edit made
   * between scans is picked up once the manifest is invalidated.
   */
  async readFile(path: string): Promise<ArmoryFile> {
    if (!isSafeArmoryPath(path)) throw new ArmoryPathError(path);

    const manifest = await this.manifest();
    const entry = manifest.entries.find((candidate) => candidate.path === path);
    if (!entry) throw new ArmoryNotFoundError(path);
    if (entry.size > MAX_ARMORY_FILE_BYTES) throw new ArmoryTooLargeError(path, entry.size);

    const target = resolve(this.root, path);
    if (!isStrictDescendant(this.root, target)) throw new ArmoryPathError(path);

    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new ArmoryNotFoundError(path);
      throw error;
    });
    if (!info.isFile()) throw new ArmoryNotFoundError(path);
    if (info.size > MAX_ARMORY_FILE_BYTES) throw new ArmoryTooLargeError(path, info.size);

    const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
    const text = decodeUtf8(bytes);
    const { size, sha256, mode, section } = entry;
    return text === undefined
      ? { path, section, size, sha256, mode, encoding: "base64", contents: toBase64(bytes) }
      : { path, section, size, sha256, mode, encoding: "utf8", contents: text };
  }

  // --- scanning -------------------------------------------------------------

  private async scan(): Promise<ArmoryManifest> {
    const entries: ArmoryEntry[] = [];
    for (const section of ARMORY_SECTIONS) {
      await this.walk(join(this.root, section), section, section, entries);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const dotfileMap = await this.readDotfileMap();
    return ArmoryManifestSchema.parse({ revision: revisionOf(entries, dotfileMap), entries, dotfileMap });
  }

  private async walk(
    directory: string,
    section: ArmorySection,
    prefix: string,
    entries: ArmoryEntry[],
  ): Promise<void> {
    let contents;
    try {
      contents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }

    for (const item of contents) {
      if (IGNORED_NAMES.has(item.name)) continue;
      if (!isSafeArmoryPath(item.name)) continue;
      // Neither followed nor listed: a manifest must never name a path that
      // resolves outside the armory root on whichever host installs it.
      if (item.isSymbolicLink()) continue;

      const path = `${prefix}/${item.name}`;
      const target = join(directory, item.name);
      if (item.isDirectory()) {
        await this.walk(target, section, path, entries);
        continue;
      }
      if (!item.isFile()) continue;

      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      // Re-checked against the dirent because the entry may have been replaced
      // between `readdir` and here.
      if (!info?.isFile()) continue;

      entries.push({
        path,
        section,
        size: info.size,
        sha256: await hashFile(target),
        mode: info.mode & 0o100 ? 0o755 : 0o644,
      });
    }
  }

  private async readDotfileMap(): Promise<DotfileMap> {
    const target = join(this.root, DOTFILE_MAP_FILENAME);
    try {
      const info = await lstat(target);
      if (!info.isFile()) throw new ArmoryMapError(target, ["not a regular file"]);
    } catch (error) {
      if (error instanceof ArmoryMapError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }

    let raw: unknown;
    try {
      // `JSON.parse`, not `Bun.file().json()`: the engine's own syntax error names
      // what it choked on, where Bun's wrapper flattens it to "Failed to parse JSON".
      raw = JSON.parse(await Bun.file(target).text());
    } catch (error) {
      throw new ArmoryMapError(target, [`not valid JSON: ${(error as Error).message}`]);
    }

    const parsed = DotfileMapSchema.safeParse(raw);
    if (!parsed.success) {
      // Every entry is reported, not just the first: a human fixing the file by
      // hand should not have to rescan it once per bad line.
      const problems = parsed.error.issues.map((issue) => {
        const key = issue.path.map(String).join(".");
        return key === "" ? issue.message : `"${key}": ${issue.message}`;
      });
      throw new ArmoryMapError(target, problems);
    }
    return parsed.data;
  }
}

/**
 * The manifest's content address. Hashes only what a consumer installs — path,
 * content hash, mode, and the dotfile map — so a rescan of unchanged content
 * reproduces it exactly. The map's keys are sorted because JSON object order
 * follows however the human wrote the file.
 */
function revisionOf(entries: ArmoryEntry[], dotfileMap: DotfileMap): string {
  const body = JSON.stringify({
    entries: entries.map(({ path, sha256, mode }) => ({ path, sha256, mode })),
    dotfileMap: Object.fromEntries(
      Object.entries(dotfileMap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  });
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

async function hashFile(target: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(target).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

function isStrictDescendant(root: string, target: string): boolean {
  const within = relative(root, target);
  return within !== "" && !within.startsWith("..") && !within.startsWith(sep) && !/^[A-Za-z]:/.test(within);
}

/** The decoded text, or `undefined` when the bytes are not NUL-free valid UTF-8. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
