import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspace } from "../src/agent-workspace";

describe("findWorkspace", () => {
  const roots: string[] = [];

  async function dataDir(port: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fleet-agent-"));
    roots.push(dir);
    await Bun.write(join(dir, "atlas.json"), JSON.stringify({ port }));
    return dir;
  }

  afterEach(async () => {
    for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("resolves repo/name and the ship base URL from a nested cwd", async () => {
    const dir = await dataDir(4700);
    const deep = join(dir, "my-repo", "ws1", "src", "nested");
    await mkdir(deep, { recursive: true });

    expect(await findWorkspace(deep)).toEqual({
      repo: "my-repo",
      name: "ws1",
      baseUrl: "http://localhost:4700",
    });
  });

  test("resolves when cwd is the workspace root itself", async () => {
    const dir = await dataDir(5000);
    const workspace = join(dir, "repo", "ws");
    await mkdir(workspace, { recursive: true });

    expect(await findWorkspace(workspace)).toMatchObject({
      repo: "repo",
      name: "ws",
      baseUrl: "http://localhost:5000",
    });
  });

  test("returns null at the data-directory root", async () => {
    const dir = await dataDir(4700);
    expect(await findWorkspace(dir)).toBeNull();
  });

  test("returns null in a repo directory", async () => {
    const dir = await dataDir(4700);
    const repoDir = join(dir, "repo");
    await mkdir(repoDir, { recursive: true });
    expect(await findWorkspace(repoDir)).toBeNull();
  });

  test("returns null when there is no atlas above", async () => {
    const orphan = await mkdtemp(join(tmpdir(), "fleet-agent-orphan-"));
    roots.push(orphan);
    expect(await findWorkspace(orphan)).toBeNull();
  });

  test.each(["bad\\repo", "a".repeat(129), "bad\nrepo"])(
    "rejects an invalid disk-derived repo component %p",
    async (repo) => {
      const dir = await dataDir(4700);
      const workspace = join(dir, repo, "ws");
      await mkdir(workspace, { recursive: true });
      expect(await findWorkspace(workspace)).toBeNull();
    },
  );
});
