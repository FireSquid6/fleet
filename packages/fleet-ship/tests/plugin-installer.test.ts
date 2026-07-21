import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
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
    expect(await exists(join(homeDirectory, ".config", "opencode"))).toBe(false);
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
    const claudeHook = await Bun.file(
      join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh"),
    ).text();
    const openCodeHook = await Bun.file(openCodePlugin(homeDirectory)).text();
    const copilotHookSource = await Bun.file(copilotHook(homeDirectory)).text();
    expect(claudeHook).toContain("fleet agent in-workspace");
    expect(openCodeHook).toContain("FleetAgentActivation");
    expect(openCodeHook).toContain("fleet agent in-workspace");
    expect(copilotHookSource).toContain("fleet agent in-workspace");
    expect([claudeHook, openCodeHook, copilotHookSource].join("\n")).not.toContain("fleet-agent in-workspace");
    expect(JSON.parse(copilotHookSource)).toMatchObject({ version: 1 });
    expect((await inspectFleetPlugin({ homeDirectory })).every(({ state }) => state === "current")).toBe(
      true,
    );
  });

  test("installed shell hooks invoke fleet agent in-workspace", async () => {
    const { homeDirectory } = await fixture();
    const binDirectory = join(homeDirectory, "bin");
    await Promise.all([
      mkdir(join(homeDirectory, ".claude")),
      mkdir(join(homeDirectory, ".copilot")),
      mkdir(binDirectory),
    ]);
    const fakeFleet = join(binDirectory, "fleet");
    await Bun.write(
      fakeFleet,
      '#!/usr/bin/env bash\n[[ "$1" == "agent" && "$2" == "in-workspace" ]] || exit 64\nprintf "autosmith/worker-1\\n"\n',
    );
    await chmod(fakeFleet, 0o755);
    await installFleetPlugin({ homeDirectory });

    const env = { PATH: `${binDirectory}:${Bun.env.PATH ?? ""}` };
    const claude = Bun.spawn([
      join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh"),
    ], { env, stdout: "pipe", stderr: "pipe" });
    const [claudeExit, claudeOutput, claudeError] = await Promise.all([
      claude.exited,
      new Response(claude.stdout).text(),
      new Response(claude.stderr).text(),
    ]);
    expect(claudeExit).toBe(0);
    expect(claudeError).toBe("");
    expect(claudeOutput).toContain("You are running inside fleet workspace autosmith/worker-1.");

    const copilotSource = await Bun.file(copilotHook(homeDirectory)).json();
    const copilot = Bun.spawn(["bash", "-c", copilotSource.hooks.sessionStart[0].bash], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [copilotExit, copilotOutput, copilotError] = await Promise.all([
      copilot.exited,
      new Response(copilot.stdout).text(),
      new Response(copilot.stderr).text(),
    ]);
    expect(copilotExit).toBe(0);
    expect(copilotError).toBe("");
    expect(JSON.parse(copilotOutput)).toEqual({
      additionalContext:
        "You are running inside fleet workspace autosmith/worker-1. Before doing any work, use the skill tool to activate the fleet-agent skill and follow its instructions for this session.",
    });
  });

  test("installs only for the providers that are present", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".copilot"));

    const installations = await installFleetPlugin({ homeDirectory, pluginsDirectory });

    expect(installations).toHaveLength(1);
    expect(installations[0]?.provider).toBe("copilot");
    expect(await exists(join(homeDirectory, ".claude"))).toBe(false);
    expect(await exists(join(homeDirectory, ".config", "opencode"))).toBe(false);
  });

  test("marks the Claude Code hook script executable", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".claude"));

    await installFleetPlugin({ homeDirectory, pluginsDirectory });

    const script = join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh");
    expect((await stat(script)).mode & 0o111).not.toBe(0);
  });

  test("doctor inspection reports executable mode drift as a conflict", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".claude"));
    await installFleetPlugin({ homeDirectory, pluginsDirectory });
    const script = join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh");
    await chmod(script, 0o644);

    const [status] = await inspectFleetPlugin({
      homeDirectory,
      pluginsDirectory,
      providers: ["claude-code"],
    });

    expect(status?.state).toBe("conflict-unmanaged");
  });

  test("is idempotent and preserves user edits until forced", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true });

    const first = await installFleetPlugin({ homeDirectory, pluginsDirectory });
    expect(first[0]?.status).toBe("installed");
    const second = await installFleetPlugin({ homeDirectory, pluginsDirectory });
    expect(second[0]?.status).toBe("unchanged");

    await Bun.write(openCodePlugin(homeDirectory), "stale");
    const third = await installFleetPlugin({ homeDirectory, pluginsDirectory });
    expect(third[0]?.status).toBe("conflict");
    expect(await Bun.file(openCodePlugin(homeDirectory)).text()).toBe("stale");
    const forced = await installFleetPlugin({ homeDirectory, pluginsDirectory, force: true });
    expect(forced[0]?.status).toBe("updated");
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

  test("tracks Claude files independently and completes safe files around a conflict", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    const conflicting = join(claudeRoot(homeDirectory), "hooks", "hooks.json");
    await mkdir(join(conflicting, ".."), { recursive: true });
    await Bun.write(conflicting, "user hooks");

    const [installation] = await installFleetPlugin({ homeDirectory, pluginsDirectory });

    expect(installation?.status).toBe("conflict");
    expect(installation?.conflictPaths).toEqual([conflicting]);
    expect(await Bun.file(conflicting).text()).toBe("user hooks");
    expect(
      await exists(join(claudeRoot(homeDirectory), ".claude-plugin", "plugin.json")),
    ).toBe(true);
    const executable = join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh");
    expect((await stat(executable)).mode & 0o111).not.toBe(0);

    const forced = await installFleetPlugin({ homeDirectory, pluginsDirectory, force: true });
    expect(forced[0]?.status).toBe("updated");
    expect(await Bun.file(conflicting).text()).toBe(
      await Bun.file(join(pluginsDirectory, "claude-code", "hooks", "hooks.json")).text(),
    );
  });

  test("does not chmod a conflicting executable hook", async () => {
    const { homeDirectory, pluginsDirectory } = await fixture();
    const script = join(claudeRoot(homeDirectory), "hooks", "activate-fleet-skill.sh");
    await mkdir(join(script, ".."), { recursive: true });
    await Bun.write(script, "user script");
    await chmod(script, 0o644);

    const [installation] = await installFleetPlugin({ homeDirectory, pluginsDirectory });

    expect(installation?.status).toBe("conflict");
    expect(installation?.conflictPaths).toContain(script);
    expect((await stat(script)).mode & 0o111).toBe(0);
    expect(await Bun.file(script).text()).toBe("user script");
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

  test("inspectFleetPlugin reports absent / missing / conflict-unmanaged / current", async () => {
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
    expect(statuses[0]?.state).toBe("conflict-unmanaged");
  });
});
