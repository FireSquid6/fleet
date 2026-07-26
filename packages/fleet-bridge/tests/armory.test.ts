/**
 * armory.test.ts — exercises `ArmoryService` against real temp directories (the
 * scan is all filesystem behaviour, so there is nothing worth faking) plus the
 * `/armory` routes through the composed Elysia app.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArmoryManifestSchema } from "fleet-protocol";
import {
  ArmoryMapError,
  ArmoryNotFoundError,
  ArmoryPathError,
  ArmoryService,
} from "../src/armory/armory-service";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { Store } from "../src/store/store";
import { makeDeps, type FakeShip } from "./helpers";

const directories: string[] = [];

async function armoryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-armory-"));
  directories.push(directory);
  return join(directory, "armory");
}

async function write(root: string, path: string, contents: string | Uint8Array): Promise<string> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}

const sha256 = (contents: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(contents).digest("hex");

/** The error `promise` rejected with, failing the test if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("ArmoryService", () => {
  test("a missing armory directory yields an empty, stable manifest", async () => {
    const manifest = await new ArmoryService(await armoryDirectory()).manifest();

    expect(manifest.entries).toEqual([]);
    expect(manifest.dotfileMap).toEqual({});
    expect(manifest.revision).toMatch(/^[0-9a-f]{64}$/);

    const other = await new ArmoryService(await armoryDirectory()).manifest();
    expect(other.revision).toBe(manifest.revision);

    // An armory that exists but holds nothing is the same content as none at all.
    const empty = await armoryDirectory();
    await mkdir(join(empty, "skills"), { recursive: true });
    expect((await new ArmoryService(empty).manifest()).revision).toBe(manifest.revision);
  });

  test("scans the three sections into sorted, hashed, section-tagged entries", async () => {
    const root = await armoryDirectory();
    await write(root, "skills/my-skill/SKILL.md", "# skill");
    await write(root, "skills/my-skill/helper.py", "print(1)");
    await write(root, "plugins/claude-code/plugin.json", "{}");
    await write(root, "dotfiles/.tmux.conf", "set -g mouse on");
    await write(root, "dotfile-map.json", JSON.stringify({ ".tmux.conf": "~/.tmux.conf" }));
    await write(root, "README.md", "ignored: not in a section");
    await write(root, "notes/scratch.txt", "ignored: not a section");
    await chmod(join(root, "skills/my-skill/helper.py"), 0o700);

    const manifest = await new ArmoryService(root).manifest();

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "dotfiles/.tmux.conf",
      "plugins/claude-code/plugin.json",
      "skills/my-skill/SKILL.md",
      "skills/my-skill/helper.py",
    ]);
    expect(manifest.entries.map((entry) => entry.section)).toEqual([
      "dotfiles",
      "plugins",
      "skills",
      "skills",
    ]);
    expect(manifest.entries[2]).toEqual({
      path: "skills/my-skill/SKILL.md",
      section: "skills",
      size: 7,
      sha256: sha256("# skill"),
      mode: 0o644,
    });
    expect(manifest.entries[3]?.mode).toBe(0o755);
    expect(manifest.dotfileMap).toEqual({ ".tmux.conf": "~/.tmux.conf" });
    expect(ArmoryManifestSchema.safeParse(manifest).success).toBe(true);
  });

  test("the revision tracks content, mode, and the dotfile map — and nothing else", async () => {
    const root = await armoryDirectory();
    await write(root, "skills/one/SKILL.md", "original");
    const first = (await new ArmoryService(root).manifest()).revision;

    expect((await new ArmoryService(root).manifest()).revision).toBe(first);

    await write(root, "skills/one/SKILL.md", "changed");
    const afterContent = (await new ArmoryService(root).manifest()).revision;
    expect(afterContent).not.toBe(first);

    await write(root, "dotfile-map.json", JSON.stringify({ "x.conf": "~/x.conf" }));
    const afterMap = (await new ArmoryService(root).manifest()).revision;
    expect(afterMap).not.toBe(afterContent);

    // Key order in the map is the human's; the revision must not follow it.
    await write(root, "dotfile-map.json", JSON.stringify({ "b.conf": "~/b", "a.conf": "~/a" }));
    const one = (await new ArmoryService(root).manifest()).revision;
    await write(root, "dotfile-map.json", JSON.stringify({ "a.conf": "~/a", "b.conf": "~/b" }));
    expect((await new ArmoryService(root).manifest()).revision).toBe(one);
  });

  test("the scan is cached until invalidate()", async () => {
    const root = await armoryDirectory();
    await write(root, "skills/one/SKILL.md", "one");
    const service = new ArmoryService(root);
    const before = await service.manifest();

    await write(root, "skills/two/SKILL.md", "two");
    expect((await service.manifest()).entries).toHaveLength(1);
    expect((await service.manifest()).revision).toBe(before.revision);

    service.invalidate();
    const after = await service.manifest();
    expect(after.entries.map((entry) => entry.path)).toEqual([
      "skills/one/SKILL.md",
      "skills/two/SKILL.md",
    ]);
    expect(after.revision).not.toBe(before.revision);
  });

  test("concurrent manifest() calls share one scan result", async () => {
    const root = await armoryDirectory();
    await write(root, "skills/one/SKILL.md", "one");
    const service = new ArmoryService(root);

    const [a, b, c] = await Promise.all([service.manifest(), service.manifest(), service.manifest()]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test("symlinks are skipped, not followed", async () => {
    const root = await armoryDirectory();
    await write(root, "skills/real/SKILL.md", "real");
    const outside = await write(root, "../outside-secret.txt", "secret");
    await mkdir(join(root, "plugins"), { recursive: true });
    await symlink(outside, join(root, "skills/real/leak.txt"));
    await symlink(dirname(outside), join(root, "plugins/leak-dir"));

    const manifest = await new ArmoryService(root).manifest();

    expect(manifest.entries.map((entry) => entry.path)).toEqual(["skills/real/SKILL.md"]);
  });

  test("readFile round-trips utf8 and falls back to base64 for binary", async () => {
    const root = await armoryDirectory();
    await write(root, "skills/one/SKILL.md", "héllo ✅");
    const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x41]);
    await write(root, "plugins/p/blob.bin", binary);
    const service = new ArmoryService(root);

    const text = await service.readFile("skills/one/SKILL.md");
    expect(text).toEqual({
      path: "skills/one/SKILL.md",
      section: "skills",
      size: Buffer.byteLength("héllo ✅"),
      sha256: sha256("héllo ✅"),
      mode: 0o644,
      encoding: "utf8",
      contents: "héllo ✅",
    });

    const blob = await service.readFile("plugins/p/blob.bin");
    expect(blob.encoding).toBe("base64");
    expect(new Uint8Array(Buffer.from(blob.contents, "base64"))).toEqual(binary);
  });

  test("readFile rejects traversal, absolute paths, and anything absent from the manifest", async () => {
    const root = await armoryDirectory();
    await write(root, "skills/one/SKILL.md", "one");
    await write(root, "README.md", "outside the sections");
    const service = new ArmoryService(root);

    await expect(service.readFile("../../etc/passwd")).rejects.toBeInstanceOf(ArmoryPathError);
    await expect(service.readFile("/etc/passwd")).rejects.toBeInstanceOf(ArmoryPathError);
    await expect(service.readFile("skills/../../etc/passwd")).rejects.toBeInstanceOf(ArmoryPathError);
    await expect(service.readFile("skills\\one\\SKILL.md")).rejects.toBeInstanceOf(ArmoryPathError);
    await expect(service.readFile("")).rejects.toBeInstanceOf(ArmoryPathError);
    // Real files outside the three sections are unreachable: the manifest gates reads.
    await expect(service.readFile("README.md")).rejects.toBeInstanceOf(ArmoryNotFoundError);
    await expect(service.readFile("skills/one/missing.md")).rejects.toBeInstanceOf(ArmoryNotFoundError);
  });

  test("a broken dotfile-map.json surfaces as an error rather than an empty map", async () => {
    const badDestination = await armoryDirectory();
    await write(badDestination, "dotfile-map.json", JSON.stringify({ ".tmux.conf": "relative/dest" }));
    await expect(new ArmoryService(badDestination).manifest()).rejects.toBeInstanceOf(ArmoryMapError);

    const badSource = await armoryDirectory();
    await write(badSource, "dotfile-map.json", JSON.stringify({ "../escape": "~/escape" }));
    await expect(new ArmoryService(badSource).manifest()).rejects.toBeInstanceOf(ArmoryMapError);

    const badShape = await armoryDirectory();
    await write(badShape, "dotfile-map.json", JSON.stringify({ "a.conf": 42 }));
    await expect(new ArmoryService(badShape).manifest()).rejects.toBeInstanceOf(ArmoryMapError);

    const notAFile = await armoryDirectory();
    await mkdir(join(notAFile, "dotfile-map.json"), { recursive: true });
    await expect(new ArmoryService(notAFile).manifest()).rejects.toBeInstanceOf(ArmoryMapError);
  });

  test("the dotfile-map error names the file on disk and every offending entry", async () => {
    const badJson = await armoryDirectory();
    const jsonTarget = await write(badJson, "dotfile-map.json", "{ not json");
    const jsonError = await rejection(new ArmoryService(badJson).manifest());
    expect(jsonError.message).toContain(jsonTarget);
    expect(jsonError.message).toContain("not valid JSON");

    const badValue = await armoryDirectory();
    const valueTarget = await write(
      badValue,
      "dotfile-map.json",
      JSON.stringify({ ".tmux.conf": "tmux.conf" }),
    );
    const valueError = await rejection(new ArmoryService(badValue).manifest());
    expect(valueError.message).toContain(valueTarget);
    expect(valueError.message).toContain('".tmux.conf"');
    expect(valueError.message).toContain('destination "tmux.conf"');

    // Every bad entry is reported, and a bad key reads differently from a bad
    // value. The mistyped third entry must not hide the other two.
    const bothSides = await armoryDirectory();
    await write(
      bothSides,
      "dotfile-map.json",
      JSON.stringify({ "../escape": "~/escape", "nvim": "config/nvim", "a.conf": 42 }),
    );
    const bothError = await rejection(new ArmoryService(bothSides).manifest());
    expect(bothError.message).toContain('source "../escape"');
    expect(bothError.message).toContain('"nvim": destination "config/nvim"');
    expect(bothError.message).toContain('"a.conf": destination must be a non-empty string');
  });
});

describe("armory API", () => {
  let manager: FleetManager | undefined;

  afterEach(() => {
    manager?.shutdown();
    manager = undefined;
  });

  async function app() {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-armory-api-"));
    directories.push(directory);
    const config = { dataDirectory: directory, port: 4800, name: "bridge" };
    const store = new Store(directory);
    await store.load();
    manager = new FleetManager(config, makeDeps(new Map<string, FakeShip>()), {
      syncTimeoutMs: 50,
      store,
    });
    await manager.init();
    return { root: join(directory, "armory"), app: createApp(manager, config) };
  }

  async function call(handler: ReturnType<typeof createApp>, path: string) {
    const response = await handler.handle(new Request(`http://bridge${path}`));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  test("GET /armory returns an empty manifest when no armory directory exists", async () => {
    const { app: handler } = await app();

    const { status, body } = await call(handler, "/armory");
    expect(status).toBe(200);
    expect(body).toMatchObject({ entries: [], dotfileMap: {} });
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  test("GET /armory and /armory/file serve a populated armory", async () => {
    const { root, app: handler } = await app();
    await write(root, "skills/my-skill/SKILL.md", "# skill");
    await write(root, "dotfile-map.json", JSON.stringify({ ".tmux.conf": "~/.tmux.conf" }));

    const manifest = await call(handler, "/armory");
    expect(manifest.status).toBe(200);
    expect(manifest.body.entries).toEqual([
      {
        path: "skills/my-skill/SKILL.md",
        section: "skills",
        size: 7,
        sha256: sha256("# skill"),
        mode: 0o644,
      },
    ]);
    expect(manifest.body.dotfileMap).toEqual({ ".tmux.conf": "~/.tmux.conf" });

    const file = await call(handler, "/armory/file?path=skills/my-skill/SKILL.md");
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({ encoding: "utf8", contents: "# skill" });
  });

  test("GET /armory/file rejects traversal (400) and unknown paths (404)", async () => {
    const { root, app: handler } = await app();
    await write(root, "skills/my-skill/SKILL.md", "# skill");

    expect((await call(handler, "/armory/file?path=../../etc/passwd")).status).toBe(400);
    expect((await call(handler, "/armory/file?path=/etc/passwd")).status).toBe(400);
    expect((await call(handler, "/armory/file?path=skills/nope.md")).status).toBe(404);
    expect((await call(handler, "/armory/file")).status).toBe(422);
  });
});
