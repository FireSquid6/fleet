import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

export const RepoSchema = z.object({
  /** Unique repo name; also the ship-side directory under `fleetDirectory`. */
  name: FleetIdentifierSchema,
  url: z.string(),
  /** Where the repo is hosted (e.g. "github", "gitlab", or "custom"). */
  provider: z.string(),
});

export type Repo = z.infer<typeof RepoSchema>;

export const CreateRepoInputSchema = RepoSchema.omit({ provider: true }).extend({
  provider: z.string().optional(),
});

export type CreateRepoInput = z.infer<typeof CreateRepoInputSchema>;
