/**
 * src/repo.ts — the repo record the bridge owns and serves from `GET /repos`.
 *
 * A repo is a bridge-registered git project with a unique `name` (which is also
 * the directory a workspace clone lands under on the ship) and a clone `url`.
 * The runtime schemas keep persisted and service-boundary data aligned with the
 * exported types.
 */

import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

export const RepoSchema = z.object({
  /** Unique repo name; also the ship-side directory under `fleetDirectory`. */
  name: FleetIdentifierSchema,
  /** Git clone URL. */
  url: z.string(),
  /** Where the repo is hosted (e.g. "github", "gitlab", or "custom"). */
  provider: z.string(),
});

export type Repo = z.infer<typeof RepoSchema>;

export const CreateRepoInputSchema = RepoSchema.omit({ provider: true }).extend({
  provider: z.string().optional(),
});

export type CreateRepoInput = z.infer<typeof CreateRepoInputSchema>;
