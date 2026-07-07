/**
 * store.ts — JSON persistence of the connected-ship roster.
 *
 * The bridge keeps its list of ships in `<dataDirectory>/ships.json` so the
 * fleet survives a restart. Only the durable identity of each ship is stored
 * (`name` + `url`); online/offline status is runtime-only and rebuilt by
 * reconnecting on startup. The file is rewritten only on membership changes
 * (add/remove ship), via write-tmp-then-rename so a crash never leaves a
 * half-written file.
 */

import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const StoreSchema = z.object({
  version: z.literal(1),
  ships: z.array(z.object({ name: z.string(), url: z.string() })),
});

/** A persisted ship: its discovered name and base URL. */
export type ShipRecord = z.infer<typeof StoreSchema>["ships"][number];

/** Absolute path of the roster file inside a data directory. */
export function storePath(dataDirectory: string): string {
  return join(dataDirectory, "ships.json");
}

/** Load the persisted ship roster; a missing file is an empty roster (first run). */
export async function loadStore(dataDirectory: string): Promise<ShipRecord[]> {
  const file = Bun.file(storePath(dataDirectory));
  if (!(await file.exists())) return [];
  return StoreSchema.parse(JSON.parse(await file.text())).ships;
}

/** Atomically persist the ship roster to `<dataDirectory>/ships.json`. */
export async function saveStore(dataDirectory: string, ships: ShipRecord[]): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const path = storePath(dataDirectory);
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify({ version: 1, ships }, null, 2));
  await rename(tmp, path);
}
