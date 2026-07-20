/**
 * atlas.ts — writes the ship's `atlas.json` discovery file.
 *
 * The file lives at the root of the ship's data directory (`fleetDirectory`).
 * Since workspaces live at `<fleetDirectory>/<repo>/<name>`, an agent inside a
 * workspace can walk up to find it and learn the local port to reach the ship.
 */

import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { ATLAS_FILENAME, type Atlas } from "fleet-protocol";

export function atlasPath(fleetDirectory: string): string {
  return join(fleetDirectory, ATLAS_FILENAME);
}

export async function writeAtlas(fleetDirectory: string, atlas: Atlas): Promise<void> {
  const target = atlasPath(fleetDirectory);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(fleetDirectory, `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(atlas, null, 2));
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
