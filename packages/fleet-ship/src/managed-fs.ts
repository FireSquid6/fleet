/** Filesystem ownership and atomic writes shared by Fleet's integration installers. */

import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

export type ManagedKind = "skill" | "plugin";
export type WriteStatus = "installed" | "updated" | "unchanged" | "adopted" | "conflict";
export type PresenceState =
  | "absent"
  | "missing"
  | "current"
  | "outdated-owned"
  | "conflict-unmanaged";

type ManifestEntry = {
  provider: string;
  kind: ManagedKind;
  sha256: string;
  mode?: number;
};

type ManifestTransition = {
  provider: string;
  kind: ManagedKind;
  previousSha256: string | null;
  previousMode?: number;
  intendedSha256: string;
  intendedMode?: number;
};

type Manifest = {
  version: 1;
  files: Record<string, ManifestEntry>;
  transitions: Record<string, ManifestTransition>;
};

export type ManagedFileFaultPoint =
  | "after-transition-manifest"
  | "before-temp-create"
  | "before-temp-chmod"
  | "before-final-rename"
  | "after-destination-write"
  | "after-final-manifest";

export type ManagedFileOptions = {
  fault?: (point: ManagedFileFaultPoint, destination: string) => void | Promise<void>;
  finalValidationFault?: (destination: string) => void;
  noReplaceFault?: (destination: string) => void;
  lockBootstrapFault?: (privatePath: string) => void;
  lockPublishedFault?: (privatePath: string, canonicalPath: string) => void;
  lockAliasRecoveryFault?: (aliasPath: string) => void;
  lockTimeoutMs?: number;
};

export type ManagedFileSession = {
  sync(
    destination: string,
    contents: string,
    ownership: { provider: string; kind: ManagedKind; force?: boolean; mode?: number },
  ): Promise<WriteStatus>;
};

const MANIFEST_RELATIVE_PATH = join(
  ".config",
  "autosmith",
  "fleet-ship",
  "managed-files-v1.json",
);
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_DATABASE_APPLICATION_ID = 0x46534c54;
const LOCK_DATABASE_MARKER = "autosmith-fleet-managed-files-lock-v1";
export const MANAGED_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const queues = new Map<string, Promise<void>>();

type FileSnapshot = {
  sha256: string;
  mode: number;
  dev: number | bigint;
  ino: number | bigint;
};
type ParentIdentity = { path: string; dev: number | bigint; ino: number | bigint };

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sha256(contents: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(contents);
  return hasher.digest("hex");
}

function bytes(contents: string): Uint8Array {
  return new TextEncoder().encode(contents);
}

function normalizedDestination(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Managed destination must be absolute: ${path}`);
  return normalize(resolve(path));
}

async function entry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function regularFile(path: string): Promise<Stats | undefined> {
  const current = await entry(path);
  if (current && (current.isSymbolicLink() || !current.isFile())) {
    throw new Error(`Refusing to replace non-file path: ${path}`);
  }
  return current;
}

async function fileHash(path: string): Promise<string> {
  return sha256(await readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
}

function fileMode(stats: Stats): number {
  return stats.mode & 0o777;
}

async function fileSnapshot(path: string): Promise<FileSnapshot | undefined> {
  const current = await regularFile(path);
  return current
    ? {
        sha256: await fileHash(path),
        mode: fileMode(current),
        dev: current.dev,
        ino: current.ino,
      }
    : undefined;
}

function fileSnapshotSync(path: string): FileSnapshot | undefined {
  let current: Stats;
  try {
    current = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error(`Refusing to replace non-file path: ${path}`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents: Buffer;
  let opened: Stats;
  try {
    opened = fstatSync(descriptor);
    contents = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (
    !opened.isFile() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw new Error(`Destination changed while installing: ${path}`);
  }
  return {
    sha256: sha256(contents),
    mode: fileMode(opened),
    dev: opened.dev,
    ino: opened.ino,
  };
}

function snapshotMatches(
  snapshot: FileSnapshot | undefined,
  sha: string | null,
  mode?: number,
): boolean {
  if (sha === null) return snapshot === undefined;
  return snapshot?.sha256 === sha && (mode === undefined || snapshot.mode === mode);
}

async function safeDirectoryPath(
  homeDirectory: string,
  path: string,
  create: boolean,
): Promise<Stats | undefined> {
  const home = resolve(homeDirectory);
  const target = resolve(path);
  const rel = relative(home, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to use path outside home directory: ${target}`);
  }

  const homeEntry = await entry(home);
  if (!homeEntry?.isDirectory() || homeEntry.isSymbolicLink()) {
    throw new Error(`Refusing to use unsafe home directory: ${home}`);
  }

  let current = home;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    const currentEntry = await entry(current);
    if (!currentEntry) {
      if (!create) return undefined;
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const created = await entry(current);
      if (!created?.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`Refusing to use non-directory path: ${current}`);
      }
    } else if (!currentEntry.isDirectory() || currentEntry.isSymbolicLink()) {
      throw new Error(`Refusing to use non-directory path: ${current}`);
    }
  }
  return entry(target);
}

/** Refuse symlinks and non-directories anywhere below the supplied home directory. */
export async function ensureSafeDirectory(homeDirectory: string, path: string): Promise<void> {
  await safeDirectoryPath(homeDirectory, path, true);
}

async function captureParent(homeDirectory: string, path: string): Promise<ParentIdentity> {
  const parent = resolve(path);
  const stats = await safeDirectoryPath(homeDirectory, parent, true);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to use unsafe parent directory: ${parent}`);
  }
  return { path: parent, dev: stats.dev, ino: stats.ino };
}

async function revalidateParent(homeDirectory: string, identity: ParentIdentity): Promise<void> {
  // Bun/Node do not expose descriptor-relative compare-and-swap/openat operations.
  // Full-path identity checks, followed by synchronous final checks and mutation,
  // narrow but cannot completely remove an external pathname race.
  const stats = await safeDirectoryPath(homeDirectory, identity.path, false);
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== identity.dev ||
    stats.ino !== identity.ino
  ) {
    throw new Error(`Managed parent directory changed during installation: ${identity.path}`);
  }
}

function revalidateParentSync(homeDirectory: string, identity: ParentIdentity): void {
  const home = resolve(homeDirectory);
  const rel = relative(home, identity.path);
  let current = home;
  for (const component of ["", ...rel.split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Managed parent directory changed during installation: ${identity.path}`);
    }
    if (
      current === identity.path &&
      (stats.dev !== identity.dev || stats.ino !== identity.ino)
    ) {
      throw new Error(`Managed parent directory changed during installation: ${identity.path}`);
    }
  }
}

/** Check provider availability without following a config-root symlink. */
export async function isDirectory(path: string): Promise<boolean> {
  const current = await entry(path);
  if (!current) return false;
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error(`Refusing to use non-directory path: ${path}`);
  }
  return true;
}

async function atomicWrite(
  homeDirectory: string,
  destination: string,
  contents: Uint8Array,
  expected: FileSnapshot | undefined,
  mode: number | undefined,
  parent: ParentIdentity,
  fault?: ManagedFileOptions["fault"],
  finalValidationFault?: ManagedFileOptions["finalValidationFault"],
  noReplaceFault?: ManagedFileOptions["noReplaceFault"],
): Promise<void> {
  const temp = join(
    dirname(destination),
    `.${destination.slice(destination.lastIndexOf(sep) + 1)}.fleet-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  await fault?.("before-temp-create", destination);
  await revalidateParent(homeDirectory, parent);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    if (mode !== undefined) {
      await fault?.("before-temp-chmod", destination);
      await handle.chmod(mode);
    }
    await handle.sync();
    await handle.close();

  await fault?.("before-final-rename", destination);
    await revalidateParent(homeDirectory, parent);
    revalidateParentSync(homeDirectory, parent);
    let current = fileSnapshotSync(destination);
    if (expected === undefined) {
      if (current) throw new Error(`Destination appeared while installing: ${destination}`);
    } else if (
      !current ||
      current.sha256 !== expected.sha256 ||
      current.mode !== expected.mode ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new Error(`Destination changed while installing: ${destination}`);
    }
    finalValidationFault?.(destination);
    revalidateParentSync(homeDirectory, parent);
    current = fileSnapshotSync(destination);
    if (expected === undefined) {
      if (current) throw new Error(`Destination appeared while installing: ${destination}`);
    } else if (
      !current ||
      current.sha256 !== expected.sha256 ||
      current.mode !== expected.mode ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new Error(`Destination changed while installing: ${destination}`);
    }
    if (expected === undefined) {
      noReplaceFault?.(destination);
      linkSync(temp, destination);
      unlinkSync(temp);
    } else {
      // Descriptor-relative compare-and-swap is unavailable; synchronous checks
      // immediately before rename leave only the unsupported external update race.
      renameSync(temp, destination);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function manifestPath(homeDirectory: string): string {
  return join(resolve(homeDirectory), MANIFEST_RELATIVE_PATH);
}

async function readManifest(path: string): Promise<Manifest> {
  const current = await regularFile(path);
  if (!current) return { version: 1, files: {}, transitions: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(
        await readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }),
      ),
    );
  } catch (error) {
    throw new Error(`Fleet managed-files manifest is invalid: ${path}`, { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    !isRecord((parsed as { files?: unknown }).files) ||
    ((parsed as { transitions?: unknown }).transitions !== undefined &&
      !isRecord((parsed as { transitions?: unknown }).transitions))
  ) {
    throw new Error(`Fleet managed-files manifest is invalid: ${path}`);
  }
  for (const [destination, value] of Object.entries((parsed as Manifest).files)) {
    if (
      normalizedDestination(destination) !== destination ||
      typeof value !== "object" ||
      value === null ||
      typeof value.provider !== "string" ||
      (value.kind !== "skill" && value.kind !== "plugin") ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      (value.mode !== undefined && !validMode(value.mode))
    ) {
      throw new Error(`Fleet managed-files manifest is invalid: ${path}`);
    }
  }
  const transitions = (parsed as Partial<Manifest>).transitions ?? {};
  for (const [destination, value] of Object.entries(transitions)) {
    if (
      normalizedDestination(destination) !== destination ||
      typeof value !== "object" ||
      value === null ||
      typeof value.provider !== "string" ||
      (value.kind !== "skill" && value.kind !== "plugin") ||
      (value.previousSha256 !== null && !/^[a-f0-9]{64}$/.test(value.previousSha256)) ||
      !/^[a-f0-9]{64}$/.test(value.intendedSha256) ||
      (value.previousMode !== undefined && !validMode(value.previousMode)) ||
      (value.intendedMode !== undefined && !validMode(value.intendedMode))
    ) {
      throw new Error(`Fleet managed-files manifest is invalid: ${path}`);
    }
  }
  return { ...(parsed as Omit<Manifest, "transitions">), transitions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
}

async function writeManifest(
  homeDirectory: string,
  path: string,
  manifest: Manifest,
): Promise<void> {
  const previous = await fileSnapshot(path);
  const parent = await captureParent(homeDirectory, dirname(path));
  await atomicWrite(
    homeDirectory,
    path,
    bytes(`${JSON.stringify(manifest, null, 2)}\n`),
    previous,
    0o600,
    parent,
  );
}

export function managedFilesLockDatabasePath(homeDirectory: string): string {
  return join(dirname(manifestPath(homeDirectory)), "managed-files-v1.lock.sqlite");
}

function validateOwnedLockFile(path: string, label: string, allowLinked = false): Stats {
  const stats = lstatSync(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (!allowLinked && stats.nlink !== 1) ||
    (currentUid !== undefined && stats.uid !== currentUid) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(`Refusing to use unsafe Fleet installer ${label}: ${path}`);
  }
  return stats;
}

function validateLockSidecars(path: string): void {
  let validWal = false;
  for (const suffix of ["-journal", "-wal", "-shm"] as const) {
    const sidecar = `${path}${suffix}`;
    let stats: Stats;
    try {
      stats = validateOwnedLockFile(sidecar, "lock database sidecar");
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const contents = readFileSync(sidecar);
    const valid =
      suffix === "-journal"
        ? stats.size >= 28 &&
          contents.subarray(0, 8).equals(Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]))
        : suffix === "-wal"
          ? stats.size >= 32 &&
            (contents.readUInt32BE(0) === 0x377f0682 || contents.readUInt32BE(0) === 0x377f0683)
          : stats.size >= 136 && validWal;
    if (!valid) {
      throw new Error(`Refusing to use unrecognized Fleet installer lock database sidecar: ${sidecar}`);
    }
    if (suffix === "-wal") validWal = true;
  }
}

function verifyFleetLockDatabase(
  path: string,
  allowLinked = false,
): { dev: number | bigint; ino: number | bigint } {
  const stats = validateOwnedLockFile(path, "lock database", allowLinked);
  const header = readFileSync(path).subarray(0, 16);
  if (!header.equals(Buffer.from("SQLite format 3\0"))) {
    throw new Error(`Refusing to use unrecognized Fleet installer lock database: ${path}`);
  }
  validateLockSidecars(path);

  const database = new Database(path, { readonly: true, strict: true });
  try {
    const application = database.query("PRAGMA application_id").get() as
      | { application_id?: number }
      | null;
    const marker = database
      .query("SELECT marker FROM fleet_lock_owner WHERE id = 1")
      .get() as { marker?: string } | null;
    if (
      application?.application_id !== LOCK_DATABASE_APPLICATION_ID ||
      marker?.marker !== LOCK_DATABASE_MARKER
    ) {
      throw new Error(`Refusing to use unrecognized Fleet installer lock database: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing to use")) throw error;
    throw new Error(`Refusing to use unrecognized Fleet installer lock database: ${path}`, {
      cause: error,
    });
  } finally {
    database.close();
  }
  return { dev: stats.dev, ino: stats.ino };
}

function verifyPublishedLockDatabase(
  homeDirectory: string,
  path: string,
  parent: ParentIdentity,
  recoveryFault?: ManagedFileOptions["lockAliasRecoveryFault"],
): { dev: number | bigint; ino: number | bigint } {
  const privatePattern = /^\.managed-files-v1\.lock\.sqlite\.fleet-\d+-[0-9a-f-]{36}\.tmp$/;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canonical = lstatSync(path);
    if (canonical.nlink === 1) return verifyFleetLockDatabase(path);
    verifyFleetLockDatabase(path, true);

    const aliases: string[] = [];
    for (const name of readdirSync(dirname(path))) {
      if (!privatePattern.test(name)) continue;
      const candidate = join(dirname(path), name);
      try {
        const candidateStats = lstatSync(candidate);
        if (candidateStats.dev === canonical.dev && candidateStats.ino === canonical.ino) {
          aliases.push(candidate);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    if (aliases.length === 0) continue;

    for (const alias of aliases) {
      recoveryFault?.(alias);
      revalidateParentSync(homeDirectory, parent);
      const latestCanonical = lstatSync(path);
      if (latestCanonical.dev !== canonical.dev || latestCanonical.ino !== canonical.ino) {
        throw new Error(`Fleet installer lock database changed during publication recovery: ${path}`);
      }
      if (latestCanonical.nlink === 1) return verifyFleetLockDatabase(path);

      let latestAlias: Stats;
      try {
        latestAlias = lstatSync(alias);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (latestAlias.dev !== canonical.dev || latestAlias.ino !== canonical.ino) continue;
      try {
        unlinkSync(alias);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  const canonical = lstatSync(path);
  if (canonical.nlink === 1) return verifyFleetLockDatabase(path);
  throw new Error(`Refusing to use hard-linked Fleet installer lock database: ${path}`);
}

function initializeLockDatabase(path: string): void {
  const database = new Database(path, { readwrite: true, strict: true });
  let transactionOpen = false;
  try {
    database.exec("PRAGMA journal_mode = MEMORY");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    database.exec(`PRAGMA application_id = ${LOCK_DATABASE_APPLICATION_ID}`);
    database.exec(
      "CREATE TABLE fleet_lock_owner (id INTEGER PRIMARY KEY CHECK (id = 1), marker TEXT NOT NULL)",
    );
    database
      .query("INSERT INTO fleet_lock_owner (id, marker) VALUES (1, ?)")
      .run(LOCK_DATABASE_MARKER);
    database.exec("COMMIT");
    transactionOpen = false;
  } finally {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {}
    }
    database.close();
  }
}

function prepareLockDatabase(
  homeDirectory: string,
  path: string,
  parent: ParentIdentity,
  bootstrapFault?: ManagedFileOptions["lockBootstrapFault"],
  publishedFault?: ManagedFileOptions["lockPublishedFault"],
  recoveryFault?: ManagedFileOptions["lockAliasRecoveryFault"],
): { dev: number | bigint; ino: number | bigint } {
  revalidateParentSync(homeDirectory, parent);
  try {
    lstatSync(path);
    return verifyPublishedLockDatabase(homeDirectory, path, parent, recoveryFault);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const privatePath = join(
    dirname(path),
    `.${path.slice(path.lastIndexOf(sep) + 1)}.fleet-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  const removePrivate = () => {
    try {
      unlinkSync(privatePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  try {
    const descriptor = openSync(
      privatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error(`Refusing to initialize unsafe Fleet installer lock database: ${privatePath}`);
      }
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    removePrivate();
    throw error;
  }

  try {
    initializeLockDatabase(privatePath);
    verifyFleetLockDatabase(privatePath);
  } catch (error) {
    removePrivate();
    throw error;
  }

  bootstrapFault?.(privatePath);
  revalidateParentSync(homeDirectory, parent);
  try {
    linkSync(privatePath, path);
    publishedFault?.(privatePath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      removePrivate();
      throw error;
    }
  }
  removePrivate();
  return verifyPublishedLockDatabase(homeDirectory, path, parent, recoveryFault);
}

async function withProcessLock<T>(
  homeDirectory: string,
  parent: ParentIdentity,
  timeoutMs: number,
  operation: () => Promise<T>,
  bootstrapFault?: ManagedFileOptions["lockBootstrapFault"],
  publishedFault?: ManagedFileOptions["lockPublishedFault"],
  recoveryFault?: ManagedFileOptions["lockAliasRecoveryFault"],
): Promise<T> {
  const path = managedFilesLockDatabasePath(homeDirectory);
  const expected = prepareLockDatabase(
    homeDirectory,
    path,
    parent,
    bootstrapFault,
    publishedFault,
    recoveryFault,
  );
  const database = new Database(path, { readwrite: true, strict: true });
  let transactionOpen = false;
  try {
    const opened = lstatSync(path);
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      throw new Error(`Fleet installer lock database changed while opening: ${path}`);
    }
    database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const result = await operation();
    database.exec("COMMIT");
    transactionOpen = false;
    return result;
  } finally {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Closing the connection is the final crash-safe lock release path.
      }
    }
    database.close();
  }
}

async function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.catch(() => {}).then(() => next);
  queues.set(key, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

async function cleanupManagedArtifacts(
  homeDirectory: string,
  parent: ParentIdentity,
  now = Date.now(),
): Promise<void> {
  await revalidateParent(homeDirectory, parent);
  const directory = parent.path;
  const tempPattern = /^\..+\.fleet-\d+-[0-9a-f-]{36}\.tmp$/;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!tempPattern.test(item.name)) continue;
    const path = join(directory, item.name);
    const stats = await entry(path);
    if (
      stats?.isFile() &&
      !stats.isSymbolicLink() &&
      now - stats.mtimeMs >= MANAGED_ARTIFACT_MAX_AGE_MS
    ) {
      revalidateParentSync(homeDirectory, parent);
      const latest = lstatSync(path);
      if (
        latest.dev === stats.dev &&
        latest.ino === stats.ino &&
        latest.isFile() &&
        !latest.isSymbolicLink() &&
        now - latest.mtimeMs >= MANAGED_ARTIFACT_MAX_AGE_MS
      ) {
        unlinkSync(path);
      }
    }
  }
}

function transitionEntry(transition: ManifestTransition): ManifestEntry {
  return {
    provider: transition.provider,
    kind: transition.kind,
    sha256: transition.intendedSha256,
    ...(transition.intendedMode === undefined ? {} : { mode: transition.intendedMode }),
  };
}

function desiredMatches(snapshot: FileSnapshot | undefined, hash: string, mode?: number): boolean {
  return snapshotMatches(snapshot, hash, mode);
}

/** Serialize one manifest read-modify-write session in-process and across Fleet processes. */
export async function withManagedFiles<T>(
  homeDirectory: string,
  operation: (session: ManagedFileSession) => Promise<T>,
  options: ManagedFileOptions = {},
): Promise<T> {
  const path = manifestPath(homeDirectory);
  return queued(path, async () => {
    await ensureSafeDirectory(homeDirectory, dirname(path));
    const initialManifestParent = await captureParent(homeDirectory, dirname(path));
    await revalidateParent(homeDirectory, initialManifestParent);
    return withProcessLock(
      homeDirectory,
      initialManifestParent,
      options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
      async () => {
      const manifestParent = await captureParent(homeDirectory, dirname(path));
      await cleanupManagedArtifacts(homeDirectory, manifestParent);
      const manifest = await readManifest(path);
      const session: ManagedFileSession = {
        async sync(destination, contents, ownership) {
          const normalized = normalizedDestination(destination);
          await ensureSafeDirectory(homeDirectory, dirname(normalized));
          const parent = await captureParent(homeDirectory, dirname(normalized));
          await cleanupManagedArtifacts(homeDirectory, parent);
          const desired = bytes(contents);
          const desiredHash = sha256(desired);
          const desiredMode = ownership.mode;
          let current = await fileSnapshot(normalized);
          let recorded = manifest.files[normalized];
          const pending = manifest.transitions[normalized];

          if (pending) {
            if (
              snapshotMatches(current, pending.intendedSha256, pending.intendedMode)
            ) {
              manifest.files[normalized] = transitionEntry(pending);
              delete manifest.transitions[normalized];
              await writeManifest(homeDirectory, path, manifest);
              await options.fault?.("after-final-manifest", normalized);
              recorded = manifest.files[normalized];
              if (
                pending.intendedSha256 === desiredHash &&
                pending.intendedMode === desiredMode
              ) {
                return pending.previousSha256 === null ? "installed" : "updated";
              }
            } else if (
              snapshotMatches(current, pending.previousSha256, pending.previousMode)
            ) {
              if (
                pending.intendedSha256 === desiredHash &&
                pending.intendedMode === desiredMode
              ) {
                await atomicWrite(
                  homeDirectory,
                  normalized,
                  desired,
                  current,
                  desiredMode,
                  parent,
                  options.fault,
                  options.finalValidationFault,
                  options.noReplaceFault,
                );
                await options.fault?.("after-destination-write", normalized);
                manifest.files[normalized] = transitionEntry(pending);
                delete manifest.transitions[normalized];
                await writeManifest(homeDirectory, path, manifest);
                await options.fault?.("after-final-manifest", normalized);
                return pending.previousSha256 === null ? "installed" : "updated";
              }
              delete manifest.transitions[normalized];
              await writeManifest(homeDirectory, path, manifest);
            } else if (!ownership.force) {
              return "conflict";
            } else {
              delete manifest.transitions[normalized];
            }
            current = await fileSnapshot(normalized);
            recorded = manifest.files[normalized];
          }

          let status: WriteStatus;
          if (!current) {
            status = "installed";
          } else if (!recorded) {
            if (current.sha256 === desiredHash) {
              const adopted: ManifestEntry = {
                provider: ownership.provider,
                kind: ownership.kind,
                sha256: desiredHash,
                mode: current.mode,
              };
              manifest.files[normalized] = adopted;
              await writeManifest(homeDirectory, path, manifest);
              await options.fault?.("after-final-manifest", normalized);
              if (desiredMode === undefined || current.mode === desiredMode) {
                status = "adopted";
              } else {
                recorded = adopted;
                status = "updated";
              }
            } else if (!ownership.force) {
              return "conflict";
            } else {
              status = "updated";
            }
          } else if (!snapshotMatches(current, recorded.sha256, recorded.mode)) {
            if (!ownership.force) return "conflict";
            status = "updated";
          } else if (desiredMatches(current, desiredHash, desiredMode)) {
            if (recorded.mode !== desiredMode) {
              manifest.files[normalized] = {
                provider: ownership.provider,
                kind: ownership.kind,
                sha256: desiredHash,
                ...(desiredMode === undefined ? {} : { mode: desiredMode }),
              };
              await writeManifest(homeDirectory, path, manifest);
            }
            status = "unchanged";
          } else {
            status = "updated";
          }

          if (status === "adopted" || status === "unchanged") return status;

          const transition: ManifestTransition = {
            provider: ownership.provider,
            kind: ownership.kind,
            previousSha256: current?.sha256 ?? null,
            ...(current === undefined ? {} : { previousMode: current.mode }),
            intendedSha256: desiredHash,
            ...(desiredMode === undefined ? {} : { intendedMode: desiredMode }),
          };
          manifest.transitions[normalized] = transition;
          await writeManifest(homeDirectory, path, manifest);
          await options.fault?.("after-transition-manifest", normalized);
          await atomicWrite(
            homeDirectory,
            normalized,
            desired,
            current,
            desiredMode,
            parent,
            options.fault,
            options.finalValidationFault,
            options.noReplaceFault,
          );
          await options.fault?.("after-destination-write", normalized);
          manifest.files[normalized] = transitionEntry(transition);
          delete manifest.transitions[normalized];
          await writeManifest(homeDirectory, path, manifest);
          await options.fault?.("after-final-manifest", normalized);
          return status;
        },
      };
        return await operation(session);
      },
      options.lockBootstrapFault,
      options.lockPublishedFault,
      options.lockAliasRecoveryFault,
    );
  });
}

export async function inspectManagedFile(
  homeDirectory: string,
  destination: string,
  contents: string,
  mode?: number,
): Promise<Exclude<PresenceState, "absent">> {
  const normalized = normalizedDestination(destination);
  await safeDirectoryPath(homeDirectory, dirname(normalized), false);
  const current = await fileSnapshot(normalized);
  if (!current) return "missing";
  const path = manifestPath(homeDirectory);
  await safeDirectoryPath(homeDirectory, dirname(path), false);
  const manifest = await readManifest(path);
  const transition = manifest.transitions[normalized];
  if (transition) {
    if (snapshotMatches(current, transition.intendedSha256, transition.intendedMode)) {
      return desiredMatches(current, sha256(bytes(contents)), mode) ? "current" : "outdated-owned";
    }
    if (!snapshotMatches(current, transition.previousSha256, transition.previousMode)) {
      return "conflict-unmanaged";
    }
    return desiredMatches(current, sha256(bytes(contents)), mode) ? "current" : "outdated-owned";
  }
  const recorded = manifest.files[normalized];
  if (!recorded) return "conflict-unmanaged";
  if (!snapshotMatches(current, recorded.sha256, recorded.mode)) return "conflict-unmanaged";
  return desiredMatches(current, sha256(bytes(contents)), mode) ? "current" : "outdated-owned";
}

/** Exposed for focused manifest tests and diagnostics. */
export function managedFilesManifestPath(homeDirectory: string): string {
  return manifestPath(homeDirectory);
}
