/**
 * armory/armory-cache.ts — the ship's local mirror of a bridge's armory.
 *
 * The bridge pushes `POST /armory/sync {bridgeUrl, revision}`; this class does
 * the pulling. It caches files and nothing else: turning the cache into
 * installed skills, plugins, and dotfiles is a separate concern that reads from
 * here (armory-installer.ts, wired up by armory-sync.ts). The one thing it
 * keeps on that installer's behalf is the summary it reports back, so a single
 * `state.json` answers "what did this ship pull, and what came of it".
 *
 *   <home>/.config/autosmith/fleet-ship/armory/
 *     files/<armory-relative path>   mirrors the bridge's armory tree
 *     state.json                     the applied revision and its entry list
 *
 * The location is deliberate. It is *not* under the ship's `fleetDirectory`,
 * where `WorkspaceManager` enumerates every top-level directory as a candidate
 * repo and would walk the cache as if it were one. It is under HOME because
 * that is the root the shared managed-file machinery validates every path
 * against, so the installers built on top of this cache need no new roots.
 *
 * A manifest is untrusted network input: every path is re-validated with
 * `isSafeArmoryPath`, every destination is proved a strict descendant of
 * `files/`, and every downloaded body is verified against the manifest's sha256
 * before it lands. A single bad file fails the whole sync — a half-applied
 * armory must never be recorded under a revision that promises all of it.
 *
 * The push also chooses *which* bridge to pull from, so it is pinned: see
 * `requirePinnedBridge` for what that does and does not protect against.
 */

import { chmod, lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  ArmoryEntrySchema,
  ArmoryFileSchema,
  ArmoryInstallSummarySchema,
  ArmoryManifestSchema,
  ArmorySyncRequestSchema,
  DotfileMapSchema,
  isSafeArmoryPath,
  type ArmoryEntry,
  type ArmoryInstallSummary,
  type ArmorySyncRequest,
  type ArmorySyncState,
  type DotfileMap,
} from "fleet-protocol";

/** The cache root, relative to the home directory. */
const CACHE_RELATIVE_PATH = join(".config", "autosmith", "fleet-ship", "armory");

/** Where `ArmoryCache` keeps its mirror, for the installer that reads it back. */
export function armoryCacheDirectory(homeDirectory: string): string {
  return join(resolve(homeDirectory), CACHE_RELATIVE_PATH);
}

/**
 * The dotfile map of the last pull. It lives in `state.json` rather than in
 * `files/` because it is manifest metadata, not an armory file: the bridge may
 * serve a map naming sources the ship never caches, and the dotfile linker must
 * act on exactly the map that came with the revision it is installing.
 */
export async function cachedDotfileMap(cacheDirectory: string): Promise<DotfileMap> {
  return (await readCachedState(resolve(cacheDirectory))).dotfileMap;
}

/** A sync that failed, carrying the status the ship's route should answer with. */
export class ArmorySyncError extends Error {
  constructor(
    message: string,
    /**
     * 400 for a malformed push, 403 for a push naming a bridge this ship is not
     * pinned to, 502 for anything the bridge did or served.
     */
    readonly status = 502,
  ) {
    super(message);
    this.name = "ArmorySyncError";
  }
}

/**
 * `state.json`. A superset of the reported `ArmorySyncState`: it also keeps the
 * entry list of the applied revision, which is what lets an unchanged push skip
 * the pull without re-hashing the whole cache.
 */
const CachedStateSchema = z.object({
  revision: z.string().nullable(),
  bridgeUrl: z.string().nullable(),
  syncedAt: z.string().nullable(),
  entries: ArmoryEntrySchema.array(),
  /** Defaulted so a `state.json` written before dotfiles existed still parses. */
  dotfileMap: DotfileMapSchema.default({}),
  /** Recorded by whoever installs from the cache; the cache never produces it. */
  install: ArmoryInstallSummarySchema.nullable().default(null),
  lastError: z.string().nullable(),
});

type CachedState = z.infer<typeof CachedStateSchema>;

const EMPTY_STATE: CachedState = {
  revision: null,
  bridgeUrl: null,
  syncedAt: null,
  entries: [],
  dotfileMap: {},
  install: null,
  lastError: null,
};

/**
 * A bridge URL reduced to the identity two pushes are compared on: scheme, host,
 * port, and path, with any trailing slash dropped. `new URL` already lowercases
 * the scheme and host and drops the port when it is the scheme's default, so
 * `http://Bridge:4800/` and `http://bridge:4800` normalize alike. Query and
 * fragment are not part of a bridge's identity and are discarded.
 *
 * Returns `null` for anything that is not a URL, which can only ever compare
 * unequal — an unparseable value must not be able to match a pinned bridge.
 */
export function normalizeBridgeUrl(bridgeUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(bridgeUrl);
  } catch {
    return null;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Missing or unreadable is simply a cold cache; the next sync rebuilds it. */
async function readCachedState(root: string): Promise<CachedState> {
  try {
    const parsed = CachedStateSchema.safeParse(await Bun.file(join(root, "state.json")).json());
    return parsed.success ? parsed.data : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

export class ArmoryCache {
  readonly homeDirectory: string;
  /** The cache root, so an installer can find `files/` without recomputing it. */
  readonly cacheDirectory: string;
  private readonly root: string;
  private readonly filesRoot: string;
  private readonly statePath: string;
  private readonly fetchImpl: typeof fetch;
  /** The ship's configured bridge, if it has one; see `requirePinnedBridge`. */
  private readonly configuredBridgeUrl?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options?: { homeDirectory?: string; fetch?: typeof fetch; bridgeUrl?: string }) {
    this.homeDirectory = resolve(options?.homeDirectory ?? homedir());
    this.root = armoryCacheDirectory(this.homeDirectory);
    this.cacheDirectory = this.root;
    this.filesRoot = join(this.root, "files");
    this.statePath = join(this.root, "state.json");
    this.fetchImpl = options?.fetch ?? fetch;
    this.configuredBridgeUrl = options?.bridgeUrl;
  }

  private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The last recorded state; zeroed when nothing has ever synced. */
  async state(): Promise<ArmorySyncState> {
    return reported(await this.readState());
  }

  /**
   * Pull the armory from `bridgeUrl` and make the cache match it exactly.
   * Rejects (recording `lastError` first) if anything about the pull is wrong.
   */
  async sync(request: ArmorySyncRequest): Promise<ArmorySyncState> {
    const parsed = ArmorySyncRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new ArmorySyncError(`invalid armory sync request: ${formatIssues(parsed.error)}`, 400);
    }

    return this.serialized(async () => {
      const previous = await this.readState();
      // Before the try: a refused push is not this ship's failure, so it must
      // not land in `lastError` and make an in-sync ship report as broken.
      this.requirePinnedBridge(parsed.data.bridgeUrl, previous.bridgeUrl);
      try {
        const next = await this.pull(parsed.data, previous);
        await this.writeState(next);
        return reported(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Best-effort: the sync's own failure is what the caller must see, so a
        // failure to record it must not replace it.
        await this.writeState({ ...previous, lastError: message }).catch(() => {});
        throw error;
      }
    });
  }

  /**
   * Record what an installer made of the cache. `lastError` is set separately
   * from `install` so a failed install can be reported without erasing the
   * successful pull that preceded it.
   */
  async recordInstall(
    install: ArmoryInstallSummary | null,
    lastError: string | null = null,
  ): Promise<ArmorySyncState> {
    return this.serialized(async () => {
      const next: CachedState = { ...(await this.readState()), install, lastError };
      await this.writeState(next);
      return reported(next);
    });
  }

  /**
   * Refuse a push naming any bridge but the one this ship is pinned to, before
   * a single byte is fetched.
   *
   * What this buys: a push decides which server the ship downloads skills,
   * plugins, and dotfiles from and installs into the agent config directories of
   * whoever runs the ship. Letting the caller choose that server is gratuitous,
   * and pinning takes it away.
   *
   * What it does not buy: the ship's API is unauthenticated, so anyone who can
   * reach the port can still make the ship re-pull from its *real* bridge. That
   * is harmless — it installs exactly what the operator already publishes. This
   * is defence in depth, not authentication; a ship's API must still never be
   * exposed to an untrusted network.
   *
   * The pin is the configured `bridgeUrl` when there is one, and otherwise
   * trust-on-first-use: the first push's bridge is recorded in `state.json` and
   * every later push must match it. That keeps a hand-started ship usable with
   * no extra flag, at the cost of the very first push being unchecked.
   */
  private requirePinnedBridge(offered: string, recorded: string | null): void {
    const expected = this.configuredBridgeUrl ?? recorded;
    if (expected === null || expected === undefined) return;

    const wanted = normalizeBridgeUrl(expected);
    if (wanted !== null && wanted === normalizeBridgeUrl(offered)) return;

    throw new ArmorySyncError(
      `armory push refused: this ship is pinned to bridge ${expected} but the push named ${offered}` +
        (this.configuredBridgeUrl === undefined
          ? "; the pin is the first bridge that pushed to this ship"
          : "; the pin is this ship's configured --bridge-url"),
      403,
    );
  }

  private async pull(request: ArmorySyncRequest, previous: CachedState): Promise<CachedState> {
    const base = this.baseUrl(request.bridgeUrl);
    const manifest = await this.fetchManifest(base);

    for (const entry of manifest.entries) {
      if (!isSafeArmoryPath(entry.path)) {
        throw new ArmorySyncError(`bridge served an unsafe armory path: ${entry.path}`);
      }
    }

    const applied: CachedState = {
      revision: manifest.revision,
      bridgeUrl: request.bridgeUrl,
      syncedAt: new Date().toISOString(),
      entries: manifest.entries,
      dotfileMap: manifest.dotfileMap,
      install: previous.install,
      lastError: null,
    };

    // The revision covers the map too, so an unchanged revision cannot have
    // brought a new one; `applied` still carries it forward for the installer.
    if (manifest.revision === previous.revision && sameEntries(manifest.entries, previous.entries)) {
      return applied;
    }

    await mkdir(this.filesRoot, { recursive: true });
    for (const entry of manifest.entries) await this.materialize(base, entry);
    await this.prune(new Set(manifest.entries.map((entry) => entry.path)));
    return applied;
  }

  /** Bring one entry's file on disk in line with the manifest. */
  private async materialize(base: string, entry: ArmoryEntry): Promise<void> {
    const target = resolve(this.filesRoot, entry.path);
    if (!isStrictDescendant(this.filesRoot, target)) {
      throw new ArmorySyncError(`armory path escapes the cache: ${entry.path}`);
    }

    const current = await lstat(target).catch(() => undefined);
    if (current?.isFile() && current.size === entry.size && (await hashFile(target)) === entry.sha256) {
      return;
    }
    // A directory (or symlink) where a file now belongs would defeat the rename
    // below; pruning runs too late to clear it. Confined to `files/`.
    if (current && !current.isFile()) await rm(target, { recursive: true, force: true });

    const bytes = await this.fetchFile(base, entry);
    await this.ensureParent(entry.path);
    await atomicWrite(target, bytes, entry.mode);
  }

  /**
   * `mkdir -p` for an entry's parent, clearing anything non-directory in the
   * way. An armory that turns `skills/one` from a file into a directory would
   * otherwise wedge every future sync. Confined to `files/`.
   */
  private async ensureParent(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    let directory = this.filesRoot;
    for (const segment of segments) {
      directory = join(directory, segment);
      const info = await lstat(directory).catch(() => undefined);
      if (info && !info.isDirectory()) await rm(directory, { recursive: true, force: true });
    }
    await mkdir(directory, { recursive: true });
  }

  private async fetchManifest(base: string) {
    const body = await this.getJson(`${base}/armory`, "manifest");
    const parsed = ArmoryManifestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ArmorySyncError(`bridge served an invalid armory manifest: ${formatIssues(parsed.error)}`);
    }
    return parsed.data;
  }

  /** The entry's verified bytes, decoded from whichever encoding the bridge used. */
  private async fetchFile(base: string, entry: ArmoryEntry): Promise<Uint8Array> {
    const url = `${base}/armory/file?path=${encodeURIComponent(entry.path)}`;
    const body = await this.getJson(url, `file ${entry.path}`);
    const parsed = ArmoryFileSchema.safeParse(body);
    if (!parsed.success) {
      throw new ArmorySyncError(`bridge served an invalid armory file for ${entry.path}: ${formatIssues(parsed.error)}`);
    }
    if (parsed.data.path !== entry.path) {
      throw new ArmorySyncError(
        `bridge served ${parsed.data.path} when asked for ${entry.path}`,
      );
    }

    // Undecodable base64 needs no separate check: `Buffer.from` drops what it
    // cannot read, and the hash below rejects whatever comes out.
    const bytes =
      parsed.data.encoding === "base64"
        ? new Uint8Array(Buffer.from(parsed.data.contents, "base64"))
        : new TextEncoder().encode(parsed.data.contents);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) {
      throw new ArmorySyncError(
        `armory file ${entry.path} does not match the manifest hash (expected ${entry.sha256}, got ${digest})`,
      );
    }
    return bytes;
  }

  private async getJson(url: string, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (error) {
      throw new ArmorySyncError(`could not reach the bridge for the armory ${what}: ${message(error)}`);
    }
    if (!response.ok) {
      throw new ArmorySyncError(`bridge answered ${response.status} for the armory ${what}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ArmorySyncError(`bridge served unparseable JSON for the armory ${what}: ${message(error)}`);
    }
  }

  /**
   * The bridge's base URL, trailing slash stripped. Request URLs are built by
   * concatenation rather than `new URL(path, base)` so a bridge mounted under a
   * path prefix keeps it.
   */
  private baseUrl(bridgeUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(bridgeUrl);
    } catch {
      throw new ArmorySyncError(`invalid bridge url: ${bridgeUrl}`, 400);
    }
    // `fetch` speaks `file:` and `data:` too; a push must not be able to turn
    // this into a local-file read.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ArmorySyncError(`bridge url must be http(s): ${bridgeUrl}`, 400);
    }
    return bridgeUrl.replace(/\/+$/, "");
  }

  /** Delete every cached file the manifest no longer names, and any directory that leaves empty. */
  private async prune(keep: Set<string>): Promise<void> {
    await pruneDirectory(this.filesRoot, "", keep);
  }

  private async readState(): Promise<CachedState> {
    return readCachedState(this.root);
  }

  /** Written last and atomically: a crash mid-sync leaves the old state, so the next sync redoes the work. */
  private async writeState(state: CachedState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await atomicWrite(this.statePath, new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`), 0o600);
  }
}

/** Drop the on-disk-only bookkeeping to get what a ship reports over HTTP. */
function reported(state: CachedState): ArmorySyncState {
  return {
    revision: state.revision,
    bridgeUrl: state.bridgeUrl,
    syncedAt: state.syncedAt,
    fileCount: state.entries.length,
    install: state.install,
    lastError: state.lastError,
  };
}

function sameEntries(a: ArmoryEntry[], b: ArmoryEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return (
      entry.path === other.path &&
      entry.sha256 === other.sha256 &&
      entry.mode === other.mode &&
      entry.size === other.size
    );
  });
}

/** The number of files kept under `directory`, after deleting everything else. */
async function pruneDirectory(root: string, prefix: string, keep: Set<string>): Promise<number> {
  const directory = prefix === "" ? root : join(root, prefix);
  let contents;
  try {
    contents = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return 0;
    throw error;
  }

  let kept = 0;
  for (const item of contents) {
    const path = prefix === "" ? item.name : `${prefix}/${item.name}`;
    const target = join(directory, item.name);
    if (item.isDirectory()) {
      const remaining = await pruneDirectory(root, path, keep);
      if (remaining === 0) await rmdir(target).catch(() => undefined);
      kept += remaining;
      continue;
    }
    if (keep.has(path)) {
      kept++;
      continue;
    }
    await rm(target, { force: true });
  }
  return kept;
}

async function atomicWrite(target: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await Bun.write(temporary, bytes);
    // Before the rename, so the file is never briefly visible at `target` with
    // the wrong mode.
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function hashFile(target: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  // Streamed rather than read whole: armory files run to megabytes. Driven
  // through the reader instead of `for await`, because the DOM lib's
  // `ReadableStream` declares no `[Symbol.asyncIterator]` and this module is
  // compiled under that lib by the web client.
  const reader = Bun.file(target).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

function isStrictDescendant(root: string, target: string): boolean {
  const within = relative(root, target);
  return within !== "" && !within.startsWith("..") && !within.startsWith(sep) && !/^[A-Za-z]:/.test(within);
}

/** Zod's default rendering is a JSON blob; this keeps the message readable in an HTTP body. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.map(String).join(".")}: ${issue.message}`))
    .join("; ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
