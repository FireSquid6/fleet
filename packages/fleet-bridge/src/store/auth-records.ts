/**
 * auth-records.ts — persistence schemas for the bridge's auth collections.
 *
 * Bridge-only (like `BridgeConfigSchema`), so they live here rather than in the
 * shared `fleet-protocol` package. The `Store` validates `users.json` /
 * `sessions.json` against these on load and on every write, mirroring how it
 * validates ships/repos with `ShipSchema` / `RepoSchema`.
 */

import { z } from "zod";

/** A local account: username is the unique key; `passwordHash` is a `Bun.password` (argon2id) hash. */
export const UserRecordSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  createdAt: z.number().int(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

/** An opaque, server-stored session. `token` is the cookie value and the map key. */
export const SessionRecordSchema = z.object({
  token: z.string().min(1),
  userId: z.string().min(1),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
