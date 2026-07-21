import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStartupIntegrations } from "../src/index";

describe("startup integration installation", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("warns for conflicts and continues without replacing them", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "fleet-startup-home-"));
    const pluginsDirectory = await mkdtemp(join(tmpdir(), "fleet-startup-plugins-"));
    directories.push(homeDirectory, pluginsDirectory);
    const sourcePath = join(homeDirectory, "source-skill.md");
    const skillPath = join(homeDirectory, ".config", "opencode", "skills", "fleet-agent", "SKILL.md");
    const pluginPath = join(homeDirectory, ".config", "opencode", "plugins", "fleet-agent.js");
    await Bun.write(sourcePath, "fleet skill");
    await Bun.write(join(pluginsDirectory, "opencode.js"), "fleet plugin");
    await mkdir(join(skillPath, ".."), { recursive: true });
    await mkdir(join(pluginPath, ".."), { recursive: true });
    await Bun.write(skillPath, "user skill");
    await Bun.write(pluginPath, "user plugin");
    const warning = spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      installStartupIntegrations({ homeDirectory, skillSourcePath: sourcePath, pluginsDirectory }),
    ).resolves.toBeUndefined();

    expect(await Bun.file(skillPath).text()).toBe("user skill");
    expect(await Bun.file(pluginPath).text()).toBe("user plugin");
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls.flat().join("\n")).toContain(pluginPath);
    warning.mockRestore();
  });

  for (const failing of ["skill", "plugin"] as const) {
    test(`warns and continues when the ${failing} installer fails independently`, async () => {
      const calls: string[] = [];
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      const failingPath = `/home/tester/.config/${failing}-failure`;

      await expect(
        installStartupIntegrations({
          installers: {
            skill: async () => {
              calls.push("skill");
              if (failing === "skill") throw new Error(`permission denied: ${failingPath}`);
              return [];
            },
            plugin: async () => {
              calls.push("plugin");
              if (failing === "plugin") throw new Error(`permission denied: ${failingPath}`);
              return [];
            },
          },
        }),
      ).resolves.toBeUndefined();

      expect(calls).toEqual(["skill", "plugin"]);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[0]).toContain(failingPath);
      expect(warning.mock.calls[0]?.[0]).toContain("fleet ship plugin install all");
      warning.mockRestore();
    });
  }
});
