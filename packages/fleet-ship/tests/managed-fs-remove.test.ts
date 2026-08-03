import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withManagedFiles } from "../src/managed-fs";

describe("ManagedFileSession.remove", () => {
  const dirs: string[] = [];
  const owner = { provider: "claude-code", kind: "skill" } as const;

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const home = async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-managed-remove-"));
    dirs.push(directory);
    return directory;
  };

  const exists = async (path: string) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };

  test("removes a file Fleet still owns", async () => {
    const homeDirectory = await home();
    const destination = join(homeDirectory, ".claude", "skills", "demo", "SKILL.md");

    const outcome = await withManagedFiles(homeDirectory, async (session) => {
      await session.sync(destination, "# demo\n", { ...owner, mode: 0o644 });
      return session.remove(destination, owner);
    });

    expect(outcome).toBe("removed");
    expect(await exists(destination)).toBe(false);
  });

  test("keeps a file the user has edited since it was installed", async () => {
    const homeDirectory = await home();
    const destination = join(homeDirectory, ".claude", "skills", "demo", "SKILL.md");
    await withManagedFiles(homeDirectory, (session) =>
      session.sync(destination, "# demo\n", { ...owner, mode: 0o644 }),
    );
    await Bun.write(destination, "# mine\n");

    const outcome = await withManagedFiles(homeDirectory, (session) =>
      session.remove(destination, owner),
    );

    expect(outcome).toBe("not-owned");
    expect(await Bun.file(destination).text()).toBe("# mine\n");
  });

  test("reports an unmanaged file as not-owned and a vanished one as missing", async () => {
    const homeDirectory = await home();
    const unmanaged = join(homeDirectory, ".claude", "settings.json");
    await Bun.write(unmanaged, "{}\n");

    const outcomes = await withManagedFiles(homeDirectory, async (session) => [
      await session.remove(unmanaged, owner),
      await session.remove(join(homeDirectory, ".claude", "nothing-here.json"), owner),
      await session.remove(join(homeDirectory, ".nowhere", "nothing-here.json"), owner),
    ]);

    expect(outcomes).toEqual(["not-owned", "missing", "missing"]);
    expect(await Bun.file(unmanaged).text()).toBe("{}\n");
  });

  test("will not touch a destination outside the home directory", async () => {
    const homeDirectory = await home();
    const outside = await home();
    const destination = join(outside, "SKILL.md");
    await Bun.write(destination, "# elsewhere\n");

    await expect(
      withManagedFiles(homeDirectory, (session) => session.remove(destination, owner)),
    ).rejects.toThrow("outside home directory");
    expect(await Bun.file(destination).text()).toBe("# elsewhere\n");
  });

  test("does not delete a file another provider owns", async () => {
    const homeDirectory = await home();
    const destination = join(homeDirectory, ".claude", "skills", "demo", "SKILL.md");

    const outcome = await withManagedFiles(homeDirectory, async (session) => {
      await session.sync(destination, "# demo\n", { ...owner, mode: 0o644 });
      return session.remove(destination, { provider: "opencode", kind: "skill" });
    });

    expect(outcome).toBe("not-owned");
    expect(await exists(destination)).toBe(true);
  });
});
