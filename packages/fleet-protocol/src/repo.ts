/**
 * src/repo.ts — the repo record the bridge owns and serves from `GET /repos`.
 *
 * A repo is a bridge-registered git project with a unique `name` (which is also
 * the directory a workspace clone lands under on the ship) and a clone `url`.
 * Like `WorkspaceStatus`, this travels over the typed Eden surface, so it is a
 * plain interface (no zod schema).
 */

export interface Repo {
  /** Unique repo name; also the ship-side directory under `fleetDirectory`. */
  readonly name: string;
  /** Git clone URL. */
  readonly url: string;
  /** Where the repo is hosted (e.g. "github", "gitlab", or "custom"). */
  readonly provider: string;
}
