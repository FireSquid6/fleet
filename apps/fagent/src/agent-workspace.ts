/**
 * Locate the fleet workspace containing a directory.
 *
 * The ship writes `atlas.json` to its data directory, while workspaces live at
 * `<dataDir>/<repo>/<name>`. Walking upward finds the ship and derives the
 * workspace identity from the first two path segments below it.
 */

import { dirname, join, relative, resolve, sep } from "node:path";
import { AtlasSchema, FleetIdentifierSchema } from "fleet-protocol";

export interface WorkspaceLocation {
  readonly repo: string;
  readonly name: string;
  readonly baseUrl: string;
}

async function readAtlasPort(dir: string): Promise<number | null> {
  try {
    const parsed = AtlasSchema.safeParse(await Bun.file(join(dir, "atlas.json")).json());
    return parsed.success ? parsed.data.port : null;
  } catch {
    return null;
  }
}

export async function findWorkspace(startDir: string = process.cwd()): Promise<WorkspaceLocation | null> {
  const start = resolve(startDir);

  let dir = start;
  while (true) {
    const port = await readAtlasPort(dir);
    if (port !== null) {
      const segments = relative(dir, start).split(sep).filter((segment) => segment.length > 0);
      if (segments.length < 2) return null;
      const repo = FleetIdentifierSchema.safeParse(segments[0]);
      const name = FleetIdentifierSchema.safeParse(segments[1]);
      if (!repo.success || !name.success) return null;
      return { repo: repo.data, name: name.data, baseUrl: `http://localhost:${port}` };
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
