import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFleetPlugin, inspectFleetPlugin } from "../src/plugin-installer";

describe("installFleetPlugin", () => {
  const dirs: string[] = [];

  /** A fixture `plugins/` source tree mirroring the real repo layout. */
  const fixture = async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "fleet-plugin-home-"));
    const pluginsDirectory = await mkdtemp(join(tmpdir(), "fleet-plugin-src-"));
    dirs.push(homeDirectory, pluginsDirectory);

    await Bun.write(
      join(pluginsDirectory, "claude-code", ".claude-plugin", "plugin.json"),
      '{"name":"fleet-agent-bootstrap"}\n',
    );
    await Bun.write(join(pluginsDirectory, "claude-code", "hooks", "hooks.json"), '{"hooks":{}}\n');
    await Bun.write(
      join(pluginsDirectory, "claude-code", "hooks", "activate-fleet-skill.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    await Bun.write(
      join(pluginsDirectory, "opencode.js"),
      "export const FleetAgentActivation = async () => ({});\n",
    );
    await Bun.write(
      join(pluginsDirectory, "copilot", "session-start-hook.json"),
      '{"version":1,"hooks":{"sessionStart":[]}}\n',
    );

    return { homeDirectory, pluginsDirectory };
  };

  const claudeRoot = (home: string) => join(home, ".claude", "skills", "fleet-agent-bootstrap");
  const openCodePlugin = (home: string) =>
    join(home, ".config", "opencode", "plugins", "fleet-agent.js");
  const copilotHook = (home: string) =>
    join(home, ".copilot", "hooks", "fleet-agent-session-start.json");

  const exists = async (path: string) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("does nothing for providers whose config directory is absent", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();

    expect(await installFleetPlugin({ homeDirectory, pluginsDirectory })).toEqual([]);
    expect(await exists(join(homeDirectory, ".claude"))).toBe(false);
    expect(await exists(join(homeDirectory, ".config"))).toBe(false);
    expect(await exists(join(homeDirectory, ".copilot"))).toBe(false);
  });

  test("installs each provider's plugin where its config directory exists", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await Promise.all([
      mkdir(join(homeDirectory, ".claude")),
      mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true }),
      mkdir(join(homeDirectory, ".copilot")),
    ]);

    const installations = await installFleetPlugin({ homeDirectory, pluginsDirectory });

    expect(installations).toEqual([
      { provider: "claude-code", path: claudeRoot(homeDirectory), status: "installed" },
      { provider: "opencode", path: openCodePlugin(homeDirectory), status: "installed" },
      { provider: "copilot", path: copilotHook(homeDirectory), status: "installed" },
    ]);
    for (const file of ["/.claude-plugin/plugin.json", "/hooks/hooks.json", "/hooks/activate-fleet-skill.sh"]) {
      expect(await exists(claudeRoot(homeDirectory) + file)).toBe(true);
    }
    expect(await exists(openCodePlugin(homeDirectory))).toBe(true);
    expect(await exists(copilotHook(homeDirectory))).toBe(true);
  });

  test("installs the embedded plugin sources by default", async () => {
    const { homeDirectory } = await fixture();
    await Promise.all([
      mkdir(join(homeDirectory, ".claude")),
      mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true }),
      mkdir(join(homeDirectory, ".copilot")),
    ]);

    await installFleetPlugin({ homeDirectory });

    expect(
      await Bun.file(join(claudeRoot(homeDirectory), ".claude-plugin", "plugin.json")).json(),
    ).toMatchObject({ name: "fleet-agent-bootstrap" });
    expect(await Bun.file(join(claudeRoot(homeDirectory), "hooks", "hooks.json")).text()).toContain(
      "SessionStart",
    );
    expect(
      await Bun.file(join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh")).text(),
    ).toContain("fleet-agent in-workspace");
    expect(await Bun.file(openCodePlugin(homeDirectory)).text()).toContain("FleetAgentActivation");
    expect(await Bun.file(copilotHook(homeDirectory)).json()).toMatchObject({ version: 1 });
    expect((await inspectFleetPlugin({ homeDirectory })).every(({ state }) => state === "current")).toBe(
      true,
    );
  });

  test("installs only for the providers that are present", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".copilot"));

    const installations = await installFleetPlugin({ homeDirectory, pluginsDirectory });

    expect(installations).toHaveLength(1);
    expect(installations[0]?.provider).toBe("copilot");
    expect(await exists(join(homeDirectory, ".claude"))).toBe(false);
    expect(await exists(join(homeDirectory, ".config"))).toBe(false);
  });

  test("marks the Claude Code hook script executable", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".claude"));

    await installFleetPlugin({ homeDirectory, pluginsDirectory });

    const script = join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh");
    expect((await stat(script)).mode & 0o111).not.toBe(0);
  });

  test("is idempotent and updates only stale files", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true });

    const first = await installFleetPlugin({ homeDirectory, pluginsDirectory });
    expect(first[0]?.status).toBe("installed");
    const second = await installFleetPlugin({ homeDirectory, pluginsDirectory });
    expect(second[0]?.status).toBe("unchanged");

    await Bun.write(openCodePlugin(homeDirectory), "stale");
    const third = await installFleetPlugin({ homeDirectory, pluginsDirectory });
    expect(third[0]?.status).toBe("updated");
    expect(await Bun.file(openCodePlugin(homeDirectory)).text()).toBe(
      await Bun.file(join(pluginsDirectory, "opencode.js")).text(),
    );
  });

  test("refuses to write through a symlinked plugin file", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    const manifestDir = join(claudeRoot(homeDirectory), ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    const target = join(homeDirectory, "user-managed.json");
    await Bun.write(target, "user managed");
    await symlink(target, join(manifestDir, "plugin.json"));

    await expect(installFleetPlugin({ homeDirectory, pluginsDirectory })).rejects.toThrow(
      "Failed to install fleet plugin",
    );
    expect(await Bun.file(target).text()).toBe("user managed");
  });

  test("installs only the requested providers", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await Promise.all([
      mkdir(join(homeDirectory, ".claude")),
      mkdir(join(homeDirectory, ".copilot")),
    ]);

    const installations = await installFleetPlugin({
      homeDirectory,
      pluginsDirectory,
      providers: ["copilot"],
    });

    expect(installations.map(({ provider }) => provider)).toEqual(["copilot"]);
    expect(await exists(claudeRoot(homeDirectory))).toBe(false);
  });

  test("inspectFleetPlugin reports absent / missing / stale / current", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();

    let statuses = await inspectFleetPlugin({ homeDirectory, pluginsDirectory });
    expect(statuses.every((status) => status.state === "absent")).toBe(true);

    await mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true });
    statuses = await inspectFleetPlugin({ homeDirectory, pluginsDirectory, providers: ["opencode"] });
    expect(statuses[0]?.state).toBe("missing");

    await installFleetPlugin({ homeDirectory, pluginsDirectory, providers: ["opencode"] });
    statuses = await inspectFleetPlugin({ homeDirectory, pluginsDirectory, providers: ["opencode"] });
    expect(statuses[0]?.state).toBe("current");

    await Bun.write(openCodePlugin(homeDirectory), "drift");
    statuses = await inspectFleetPlugin({ homeDirectory, pluginsDirectory, providers: ["opencode"] });
    expect(statuses[0]?.state).toBe("stale");
  });
});
