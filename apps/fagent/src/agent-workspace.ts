/**
 * The ship writes `atlas.json` to its data directory; workspaces live at
 * `<dataDir>/<repo>/<name>`.
 */

import { dirname, join, relative, resolve, sep } from "node:path";
import { AtlasSchema, FleetIdentifierSchema, type Atlas } from "fleet-protocol";

export interface WorkspaceLocation {
  readonly repo: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly agentToken?: string;
}

async function readAtlas(dir: string): Promise<Atlas | null> {
  try {
    const parsed = AtlasSchema.safeParse(await Bun.file(join(dir, "atlas.json")).json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function findWorkspace(startDir: string = process.cwd()): Promise<WorkspaceLocation | null> {
  const start = resolve(startDir);

  let dir = start;
  while (true) {
    const atlas = await readAtlas(dir);
    if (atlas !== null) {
      const segments = relative(dir, start).split(sep).filter((segment) => segment.length > 0);
      if (segments.length < 2) return null;
      const repo = FleetIdentifierSchema.safeParse(segments[0]);
      const name = FleetIdentifierSchema.safeParse(segments[1]);
      if (!repo.success || !name.success) return null;
      return {
        repo: repo.data,
        name: name.data,
        baseUrl: `http://localhost:${atlas.port}`,
        agentToken: atlas.agentToken,
      };
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
