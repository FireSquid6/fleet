/**
 * armory-installer.test.ts — drives `installArmory` against a temp home holding
 * both a fabricated armory cache and fabricated provider config roots. The
 * cache is written as real files rather than mocked because what the installer
 * has to get right is bytes and modes reaching provider directories.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DotfileMap } from "fleet-protocol";
import { installArmory } from "../src/armory/armory-installer";

describe("installArmory", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const fixture = async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "fleet-armory-install-"));
    dirs.push(homeDirectory);
    const cacheDirectory = join(homeDirectory, ".config", "autosmith", "fleet-ship", "armory");
    return { homeDirectory, cacheDirectory };
  };

  /** Write one file into the fabricated cache, as `ArmoryCache` would have. */
  const cached = async (
    cacheDirectory: string,
    path: string,
    contents: string | Uint8Array,
    mode = 0o644,
  ) => {
    const target = join(cacheDirectory, "files", ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, contents);
    await chmod(target, mode);
    return target;
  };

  /** The one `state.json` field the installer reads back: the dotfile map. */
  const cachedDotfileMap = async (cacheDirectory: string, dotfileMap: DotfileMap) => {
    await mkdir(cacheDirectory, { recursive: true });
    await Bun.write(
      join(cacheDirectory, "state.json"),
      JSON.stringify({
        revision: null,
        bridgeUrl: null,
        syncedAt: null,
        entries: [],
        dotfileMap,
        install: null,
        lastError: null,
      }),
    );
  };

  const providers = async (homeDirectory: string, ...names: string[]) => {
    for (const name of names) await mkdir(join(homeDirectory, name), { recursive: true });
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

  test("returns an empty report when nothing has ever been synced", async () => {
    const { homeDirectory } = await fixture();
    await providers(homeDirectory, ".claude");

    expect(await installArmory({ homeDirectory })).toEqual({
      skills: [],
      plugins: [],
      dotfiles: [],
      removed: [],
      conflicts: [],
      warnings: [],
    });
    expect(await exists(join(homeDirectory, ".claude", "skills"))).toBe(false);
  });

  test("fans a skill out to every present provider, including both codex roots", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude", ".config/opencode", ".codex");
    await cached(cacheDirectory, "skills/demo/SKILL.md", "# demo\n");
    await cached(cacheDirectory, "skills/demo/references/notes.md", "notes\n");

    const report = await installArmory({ homeDirectory });

    const roots = [
      join(homeDirectory, ".claude", "skills"),
      join(homeDirectory, ".config", "opencode", "skills"),
      join(homeDirectory, ".codex", "skills"),
      join(homeDirectory, ".agents", "skills"),
    ];
    expect(report.skills).toHaveLength(roots.length * 2);
    expect(new Set(report.skills.map(({ skill }) => skill))).toEqual(new Set(["demo"]));
    expect(report.skills.every(({ status }) => status === "installed")).toBe(true);
    for (const root of roots) {
      expect(await Bun.file(join(root, "demo", "SKILL.md")).text()).toBe("# demo\n");
      expect(await Bun.file(join(root, "demo", "references", "notes.md")).text()).toBe("notes\n");
    }
    // Absent provider: nothing is created for it.
    expect(await exists(join(homeDirectory, ".copilot"))).toBe(false);
  });

  test("places a plugin tree under the provider's config root and keeps it executable", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude");
    await cached(cacheDirectory, "plugins/claude-code/plugins/mine/plugin.json", '{"name":"mine"}\n');
    await cached(
      cacheDirectory,
      "plugins/claude-code/plugins/mine/run.sh",
      "#!/usr/bin/env bash\nexit 0\n",
      0o755,
    );

    const report = await installArmory({ homeDirectory });

    const manifest = join(homeDirectory, ".claude", "plugins", "mine", "plugin.json");
    const script = join(homeDirectory, ".claude", "plugins", "mine", "run.sh");
    expect(report.plugins.map(({ provider, path }) => ({ provider, path }))).toEqual([
      { provider: "claude-code", path: manifest },
      { provider: "claude-code", path: script },
    ]);
    expect(await Bun.file(manifest).text()).toBe('{"name":"mine"}\n');
    expect((await stat(script)).mode & 0o777).toBe(0o755);
    expect((await stat(manifest)).mode & 0o777).toBe(0o644);
  });

  test("copies a plugin whose bytes are not valid UTF-8 byte for byte", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".copilot");
    const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41, 0xc3, 0x28]);
    await cached(cacheDirectory, "plugins/copilot/blobs/data.bin", binary);

    await installArmory({ homeDirectory });

    const installed = await Bun.file(
      join(homeDirectory, ".copilot", "blobs", "data.bin"),
    ).bytes();
    expect([...installed]).toEqual([...binary]);
  });

  test("uninstalls what left the armory, and prunes the directories that empties", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude");
    await cached(cacheDirectory, "skills/gone/SKILL.md", "# gone\n");
    await cached(cacheDirectory, "skills/gone/scripts/go.sh", "exit 0\n", 0o755);
    await cached(cacheDirectory, "skills/stays/SKILL.md", "# stays\n");
    await installArmory({ homeDirectory });

    await rm(join(cacheDirectory, "files", "skills", "gone"), { recursive: true });
    const report = await installArmory({ homeDirectory });

    const skills = join(homeDirectory, ".claude", "skills");
    expect(new Set(report.removed)).toEqual(
      new Set([join(skills, "gone", "SKILL.md"), join(skills, "gone", "scripts", "go.sh")]),
    );
    expect(await exists(join(skills, "gone"))).toBe(false);
    expect(await exists(skills)).toBe(true);
    expect(await Bun.file(join(skills, "stays", "SKILL.md")).text()).toBe("# stays\n");
    expect(report.skills.map(({ status }) => status)).toEqual(["unchanged"]);
  });

  test("leaves a user-edited file alone when the armory drops it, and says so", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude");
    await cached(cacheDirectory, "skills/gone/SKILL.md", "# gone\n");
    await installArmory({ homeDirectory });
    const destination = join(homeDirectory, ".claude", "skills", "gone", "SKILL.md");
    await Bun.write(destination, "# mine now\n");

    await rm(join(cacheDirectory, "files", "skills", "gone"), { recursive: true });
    const report = await installArmory({ homeDirectory });

    expect(report.removed).toEqual([]);
    expect(report.warnings.join("\n")).toContain(destination);
    expect(await Bun.file(destination).text()).toBe("# mine now\n");
  });

  test("preserves an unmanaged file at a destination until forced", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude");
    const destination = join(homeDirectory, ".claude", "skills", "demo", "SKILL.md");
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, "# user\n");
    await cached(cacheDirectory, "skills/demo/SKILL.md", "# armory\n");

    const conflicted = await installArmory({ homeDirectory });
    expect(conflicted.conflicts).toEqual([destination]);
    expect(conflicted.skills.map(({ status }) => status)).toEqual(["conflict"]);
    expect(await Bun.file(destination).text()).toBe("# user\n");

    const forced = await installArmory({ homeDirectory, force: true });
    expect(forced.conflicts).toEqual([]);
    expect(await Bun.file(destination).text()).toBe("# armory\n");
  });

  test("warns about an unknown plugin provider and a loose file under skills", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude");
    await cached(cacheDirectory, "skills/loose.md", "not a skill\n");
    await cached(cacheDirectory, "plugins/cursor/config.json", "{}\n");

    const report = await installArmory({ homeDirectory });

    expect(report.skills).toEqual([]);
    expect(report.plugins).toEqual([]);
    expect(report.warnings.join("\n")).toContain("skills/loose.md");
    expect(report.warnings.join("\n")).toContain("plugins/cursor");
    expect(await exists(join(homeDirectory, ".claude", "skills"))).toBe(false);
    expect(await exists(join(homeDirectory, ".claude", "config.json"))).toBe(false);
  });

  test("installs no dotfile until the cache has recorded a map for it", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude");
    await cached(cacheDirectory, "dotfiles/gitconfig", "[user]\n");

    const report = await installArmory({ homeDirectory });

    expect(report).toEqual({
      skills: [],
      plugins: [],
      dotfiles: [],
      removed: [],
      conflicts: [],
      warnings: [],
    });
    expect(await exists(join(homeDirectory, ".gitconfig"))).toBe(false);
  });

  test("symlinks the cached dotfile map, and unlinks a mapping it drops", async () => {
    const { homeDirectory, cacheDirectory } = await fixture();
    await providers(homeDirectory, ".claude");
    await cached(cacheDirectory, "dotfiles/.tmux.conf", "set -g mouse on\n");
    await cached(cacheDirectory, "dotfiles/nvim/init.lua", "vim.o.number = true\n");
    await cachedDotfileMap(cacheDirectory, {
      ".tmux.conf": "~/.tmux.conf",
      nvim: "~/.config/nvim",
    });

    const installed = await installArmory({ homeDirectory });

    const tmux = join(homeDirectory, ".tmux.conf");
    const nvim = join(homeDirectory, ".config", "nvim");
    expect(installed.dotfiles.map(({ target, status }) => ({ target, status }))).toEqual([
      { target: tmux, status: "linked" },
      { target: nvim, status: "linked" },
    ]);
    expect(await readlink(tmux)).toBe(join(cacheDirectory, "files", "dotfiles", ".tmux.conf"));
    expect(await Bun.file(join(nvim, "init.lua")).text()).toBe("vim.o.number = true\n");

    await cachedDotfileMap(cacheDirectory, { ".tmux.conf": "~/.tmux.conf" });
    const dropped = await installArmory({ homeDirectory });

    expect(dropped.dotfiles.map(({ status }) => status)).toEqual(["unchanged"]);
    expect(dropped.removed).toEqual([nvim]);
    expect(await exists(nvim)).toBe(false);
    expect(await exists(tmux)).toBe(true);
  });
});
