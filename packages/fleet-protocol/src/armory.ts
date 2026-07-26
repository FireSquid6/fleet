/**
 * src/armory.ts — the Armory contract: a bridge-owned directory of files the
 * fleet's ships install.
 *
 * A human hand-edits (or git-syncs) `<bridge dataDirectory>/armory/`:
 *
 *   armory/
 *     skills/<skill-name>/SKILL.md   plus any extra files the skill needs
 *     plugins/<provider>/...         one arbitrary tree per agent provider
 *     dotfiles/...                   arbitrary files and directories
 *     dotfile-map.json               `dotfiles/`-relative source → destination
 *
 * The bridge scans that tree into an `ArmoryManifest`, whose `revision` is a
 * content address: it changes iff a file's contents, mode, or path changes, or
 * the dotfile map changes. Ships compare revisions to decide whether to re-pull,
 * so `revision` must be a pure function of armory content — never of scan time,
 * host paths, or filesystem ordering.
 *
 * Paths inside the manifest are always POSIX-separated and relative to the
 * armory root (`skills/my-skill/SKILL.md`). `isSafeArmoryPath` is the single
 * shared validator for them; both the bridge (when serving) and the ship (when
 * installing) apply it, because a manifest is untrusted input on the ship side.
 */

import { z } from "zod";

/** Top-level directories of the armory. Anything else at the root is ignored. */
export const ARMORY_SECTIONS = ["skills", "plugins", "dotfiles"] as const;

export type ArmorySection = (typeof ARMORY_SECTIONS)[number];

/** The armory's directory name, relative to the bridge's `dataDirectory`. */
export const ARMORY_DIRECTORY = "armory";

/** The dotfile source→destination map, at the armory root. */
export const DOTFILE_MAP_FILENAME = "dotfile-map.json";

const MAX_ARMORY_PATH_BYTES = 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const utf8 = new TextEncoder();

/**
 * Whether `path` is safe to join onto an armory root on either side of the wire.
 *
 * Rejects: empty, absolute (`/`-leading or `C:`-style), any `\` (so a Windows
 * separator can never smuggle a segment past the `/` split), `.`/`..`/empty
 * segments, control characters (NUL included), and anything over 1 KiB.
 * A single path segment is a valid input too — the scanner checks directory
 * entry names with it.
 */
export function isSafeArmoryPath(path: string): boolean {
  if (path.length === 0) return false;
  if (utf8.encode(path).byteLength > MAX_ARMORY_PATH_BYTES) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (CONTROL_CHARACTERS.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A destination is only meaningful if it is home-rooted or absolute. */
function isSafeDotfileDestination(destination: string): boolean {
  if (CONTROL_CHARACTERS.test(destination)) return false;
  return destination.startsWith("~/") || destination.startsWith("/");
}

const ArmoryFileFactsSchema = z.object({
  /** POSIX-separated, relative to the armory root, e.g. `skills/my-skill/SKILL.md`. */
  path: z.string().min(1).refine(isSafeArmoryPath, "must be a safe armory-relative path"),
  section: z.enum(ARMORY_SECTIONS),
  size: z.number().int().nonnegative(),
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256"),
  /** Normalized to `0o755` (executable) or `0o644`; host mode bits never leak. */
  mode: z.number().int(),
});

export const ArmoryEntrySchema = ArmoryFileFactsSchema;

export type ArmoryEntry = z.infer<typeof ArmoryEntrySchema>;

/**
 * Keys are `armory/dotfiles/`-relative sources; values are `~/`-rooted or absolute
 * destinations.
 *
 * Every issue is reported against the offending key and names which side of the
 * pair is broken, because this schema validates a hand-edited file and its errors
 * are read by whoever has to go and fix it. That is also why the value type is
 * checked *inside* the refinement over a permissive base rather than by a
 * `z.string()` value schema: zod skips refinements once the base parse fails, so
 * a single mistyped value would otherwise hide every other bad entry in the file.
 */
export const DotfileMapSchema = z
  .record(z.string().min(1), z.unknown())
  .superRefine((map, ctx) => {
    for (const [source, destination] of Object.entries(map)) {
      if (!isSafeArmoryPath(source)) {
        ctx.addIssue({
          code: "custom",
          path: [source],
          message: `source "${source}" must be a relative path under dotfiles/ with no "..", "." or "\\" segments`,
        });
      }
      if (typeof destination !== "string" || destination.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: [source],
          message: `destination must be a non-empty string, not ${destination === null ? "null" : typeof destination}`,
        });
        continue;
      }
      if (!isSafeDotfileDestination(destination)) {
        ctx.addIssue({
          code: "custom",
          path: [source],
          message: `destination "${destination}" must start with "~/" or be absolute`,
        });
      }
    }
  })
  // Sound only because the refinement above rejected every non-string value.
  .transform((map) => map as Record<string, string>);

export type DotfileMap = z.infer<typeof DotfileMapSchema>;

export const ArmoryManifestSchema = z.object({
  /** Content address of the whole armory: lowercase hex sha256. */
  revision: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256"),
  /** Every scanned file, sorted by `path`. */
  entries: ArmoryEntrySchema.array(),
  dotfileMap: DotfileMapSchema,
});

export type ArmoryManifest = z.infer<typeof ArmoryManifestSchema>;

/** One file's contents, carrying the same facts the manifest reports for it. */
export const ArmoryFileSchema = ArmoryFileFactsSchema.extend({
  /** `utf8` when the bytes decode as text; `base64` for anything binary. */
  encoding: z.enum(["utf8", "base64"]),
  contents: z.string(),
});

export type ArmoryFile = z.infer<typeof ArmoryFileSchema>;

/**
 * Body of the bridge's `POST /armory/sync` push to a ship.
 *
 * A ship holds no bridge address of its own, so `bridgeUrl` is how it learns
 * where to pull from — and it only ever pulls from a bridge that has spoken to
 * it. `revision` is a hint that something changed, not an instruction: the ship
 * applies whatever revision the manifest it fetches reports, because the armory
 * may change again between this push and that fetch.
 */
export const ArmorySyncRequestSchema = z.object({
  bridgeUrl: z.url(),
  revision: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256"),
});

export type ArmorySyncRequest = z.infer<typeof ArmorySyncRequestSchema>;

/** What a ship reports about its armory cache. */
export const ArmorySyncStateSchema = z.object({
  /** The applied revision; `null` until the first successful sync. */
  revision: z.string().nullable(),
  bridgeUrl: z.string().nullable(),
  /** ISO timestamp of the last successful sync. */
  syncedAt: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  /** Message of the most recent failed sync, cleared by the next success. */
  lastError: z.string().nullable(),
});

export type ArmorySyncState = z.infer<typeof ArmorySyncStateSchema>;
