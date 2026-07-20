/**
 * atlas.test.ts — verifies the ship's `atlas.json` discovery file is written
 * with the reachable port and validates against the shared `AtlasSchema`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasSchema } from "fleet-protocol";
import { atlasPath, writeAtlas } from "../src/atlas";

describe("atlas", () => {
  const dirs: string[] = [];
  const tempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-ship-atlas-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("atlasPath joins the fleet directory with atlas.json", () => {
    expect(atlasPath("/data/fleet")).toBe(join("/data/fleet", "atlas.json"));
  });

  test("writeAtlas writes a schema-valid atlas.json with the port", async () => {
    const dir = await tempDir();
    await writeAtlas(dir, { port: 4700 });

    const written = await Bun.file(atlasPath(dir)).json();
    expect(written).toEqual({ port: 4700 });
    expect(AtlasSchema.parse(written).port).toBe(4700);
  });

  test("writeAtlas uses the startup-created fleet directory", async () => {
    const dir = await tempDir();
    await writeAtlas(dir, { port: 5000 });

    expect(await Bun.file(atlasPath(dir)).json()).toEqual({ port: 5000 });
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses a symlink atlas leaf without modifying its target", async () => {
    const dir = await tempDir();
    const outside = join(await tempDir(), "outside.json");
    await Bun.write(outside, "unchanged");
    await symlink(outside, atlasPath(dir));

    await expect(writeAtlas(dir, { port: 5000 })).rejects.toThrow(/symbolic link/);
    expect(await Bun.file(outside).text()).toBe("unchanged");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
