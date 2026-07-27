/**
 * dotfile-linker.test.ts — drives `linkDotfiles` against a temp home holding a
 * fabricated armory cache. Links are checked with `lstat`/`readlink` as well as
 * by reading through them: "the content is right" and "it is a symlink into the
 * cache" are separate claims, and only the second one distinguishes this
 * installer from a copy.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { linkDotfiles } from "../src/armory/dotfile-linker";

describe("linkDotfiles", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const fixture = async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "fleet-dotfile-link-"));
    dirs.push(homeDirectory);
    const cacheDirectory = join(homeDirectory, ".config", "autosmith", "fleet-ship", "armory");
    return { homeDirectory, cacheDirectory };
  };

  /** Write one file under the cache's `files/dotfiles/`, as `ArmoryCache` would have. */
  const cached = async (cacheDirectory: string, path: string, contents: string) => {
    const target = join(cacheDirectory, "files", "dotfiles", ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, contents);
    return target;
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

  test("links a file and a directory, and both read through to the cache", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    const conf = await cached(cacheDirectory, ".tmux.conf", "set -g mouse on\n");
    await cached(cacheDirectory, "nvim/init.lua", "vim.o.number = true\n");

    const report = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { ".tmux.conf": "~/.tmux.conf", nvim: "~/.config/nvim" },
    });

    const tmux = join(homeDirectory, ".tmux.conf");
    const nvim = join(homeDirectory, ".config", "nvim");
    expect(report.links).toEqual([
      { source: ".tmux.conf", target: tmux, status: "linked" },
      { source: "nvim", target: nvim, status: "linked" },
    ]);
    expect(report).toMatchObject({ removed: [], conflicts: [], warnings: [] });
    expect((await lstat(tmux)).isSymbolicLink()).toBe(true);
    expect(await readlink(tmux)).toBe(conf);
    expect(await Bun.file(tmux).text()).toBe("set -g mouse on\n");
    // One link for the whole directory, not one per file inside it.
    expect((await lstat(nvim)).isSymbolicLink()).toBe(true);
    expect(await readlink(nvim)).toBe(join(cacheDirectory, "files", "dotfiles", "nvim"));
    expect(await Bun.file(join(nvim, "init.lua")).text()).toBe("vim.o.number = true\n");
  });

  test("creates the target's missing parent directories", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, "starship.toml", "add_newline = false\n");

    const report = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { "starship.toml": "~/deeply/nested/starship.toml" },
    });

    expect(report.links.map(({ status }) => status)).toEqual(["linked"]);
    const target = join(homeDirectory, "deeply", "nested", "starship.toml");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe("add_newline = false\n");
  });

  test("re-running an unchanged map relinks nothing", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, ".tmux.conf", "set -g mouse on\n");
    const dotfileMap = { ".tmux.conf": "~/.tmux.conf" };
    await linkDotfiles({ homeDirectory, cacheDirectory, dotfileMap });

    const report = await linkDotfiles({ homeDirectory, cacheDirectory, dotfileMap });

    expect(report.links.map(({ status }) => status)).toEqual(["unchanged"]);
    expect(report.removed).toEqual([]);
  });

  test("retargets its own link when the map moves the target to another source", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, "one.conf", "one\n");
    const two = await cached(cacheDirectory, "two.conf", "two\n");
    await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { "one.conf": "~/.thing" },
    });

    const report = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { "two.conf": "~/.thing" },
    });

    const target = join(homeDirectory, ".thing");
    expect(report.links).toEqual([{ source: "two.conf", target, status: "relinked" }]);
    expect(report.removed).toEqual([]);
    expect(await readlink(target)).toBe(two);
    expect(await Bun.file(target).text()).toBe("two\n");
  });

  test("keeps a real file at the target byte-intact until forced", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, ".tmux.conf", "from the armory\n");
    const target = join(homeDirectory, ".tmux.conf");
    await writeFile(target, "mine\n");
    const dotfileMap = { ".tmux.conf": "~/.tmux.conf" };

    const conflicted = await linkDotfiles({ homeDirectory, cacheDirectory, dotfileMap });

    expect(conflicted.conflicts).toEqual([target]);
    expect(conflicted.links[0]).toMatchObject({ status: "conflict" });
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await Bun.file(target).text()).toBe("mine\n");

    const forced = await linkDotfiles({ homeDirectory, cacheDirectory, dotfileMap, force: true });

    expect(forced.conflicts).toEqual([]);
    expect(forced.links[0]).toMatchObject({ status: "linked", detail: "replaced a file" });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe("from the armory\n");
  });

  test("leaves a symlink that points outside the cache alone", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, ".tmux.conf", "from the armory\n");
    const elsewhere = join(homeDirectory, "other-dotfiles.conf");
    await writeFile(elsewhere, "somebody else's\n");
    const target = join(homeDirectory, ".tmux.conf");
    await symlink(elsewhere, target);

    const report = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { ".tmux.conf": "~/.tmux.conf" },
    });

    expect(report.conflicts).toEqual([target]);
    expect(report.links[0]?.detail).toContain(elsewhere);
    expect(await readlink(target)).toBe(elsewhere);
  });

  test("removes the link of a dropped mapping, but never its parent directory", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, ".tmux.conf", "tmux\n");
    await cached(cacheDirectory, "nvim/init.lua", "nvim\n");
    await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { ".tmux.conf": "~/.tmux.conf", nvim: "~/.config/nvim" },
    });

    const report = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { ".tmux.conf": "~/.tmux.conf" },
    });

    expect(report.removed).toEqual([join(homeDirectory, ".config", "nvim")]);
    expect(await exists(join(homeDirectory, ".config", "nvim"))).toBe(false);
    expect(await exists(join(homeDirectory, ".config"))).toBe(true);
    expect(await exists(join(homeDirectory, ".tmux.conf"))).toBe(true);
  });

  test("does not remove a target the user has since replaced with a real file", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, ".tmux.conf", "tmux\n");
    await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { ".tmux.conf": "~/.tmux.conf" },
    });
    const target = join(homeDirectory, ".tmux.conf");
    await rm(target);
    await writeFile(target, "mine now\n");

    const report = await linkDotfiles({ homeDirectory, cacheDirectory, dotfileMap: {} });

    expect(report.removed).toEqual([]);
    expect(report.warnings.join("\n")).toContain(target);
    expect(await Bun.file(target).text()).toBe("mine now\n");
  });

  test("skips a destination outside the home directory", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, "passwd", "root:x:0:0:::\n");
    await cached(cacheDirectory, "escape", "escaped\n");

    const report = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { passwd: "/etc/passwd", escape: "~/../escape" },
    });

    expect(report.links.map(({ status }) => status)).toEqual(["skipped", "skipped"]);
    expect(report.warnings.join("\n")).toContain("/etc/passwd");
    expect(report.warnings.join("\n")).toContain("~/../escape");
    expect(report.removed).toEqual([]);
    expect((await lstat("/etc/passwd")).isSymbolicLink()).toBe(false);
    expect(await exists(join(dirname(homeDirectory), "escape"))).toBe(false);
  });

  test("skips a mapping whose source is missing from the cache, or unsafe", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, "present.conf", "here\n");

    const report = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { "ghost.conf": "~/.ghost", "../outside.conf": "~/.outside" },
    });

    expect(report.links.map(({ status }) => status)).toEqual(["skipped", "skipped"]);
    expect(report.warnings.join("\n")).toContain("dotfiles/ghost.conf is not in the armory cache");
    expect(report.warnings.join("\n")).toContain("not a safe path");
    expect(await exists(join(homeDirectory, ".ghost"))).toBe(false);
    expect(await exists(join(homeDirectory, ".outside"))).toBe(false);
  });

  test("reports a failing mapping as an AggregateError without losing the others", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await cached(cacheDirectory, "blocked.conf", "blocked\n");
    await cached(cacheDirectory, "fine.conf", "fine\n");
    // A regular file where a parent directory would have to go: `mkdir` fails
    // with ENOTDIR, which is a failure rather than a conflict.
    await writeFile(join(homeDirectory, "wedged"), "not a directory\n");

    const failure = await linkDotfiles({
      homeDirectory,
      cacheDirectory,
      dotfileMap: { "blocked.conf": "~/wedged/blocked.conf", "fine.conf": "~/.fine" },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(join(homeDirectory, "wedged", "blocked.conf"));
    const fine = join(homeDirectory, ".fine");
    expect(await Bun.file(fine).text()).toBe("fine\n");

    // The successful link was recorded, so dropping its mapping still undoes it.
    const report = await linkDotfiles({ homeDirectory, cacheDirectory, dotfileMap: {} });
    expect(report.removed).toEqual([fine]);
  });
});
