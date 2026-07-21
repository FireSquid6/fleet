import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFleetSkill, inspectFleetSkill } from "../src/skill-installer";

describe("installFleetSkill", () => {
  const dirs: string[] = [];

  const fixture = async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "fleet-skill-"));
    dirs.push(homeDirectory);
    const sourcePath = join(homeDirectory, "source-SKILL.md");
    await Bun.write(sourcePath, "---\nname: fleet-agent\n---\n\nFleet instructions.\n");
    return { homeDirectory, sourcePath };
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

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("does not create config directories for absent providers", async () => {
    const fixtureOptions = await fixture();

    expect(await installFleetSkill(fixtureOptions)).toEqual([]);
    expect(await exists(join(fixtureOptions.homeDirectory, ".claude"))).toBe(false);
    expect(await exists(join(fixtureOptions.homeDirectory, ".config"))).toBe(false);
    expect(await exists(join(fixtureOptions.homeDirectory, ".copilot"))).toBe(false);
    expect(await exists(join(fixtureOptions.homeDirectory, ".codex"))).toBe(false);
    expect(await exists(join(fixtureOptions.homeDirectory, ".agents"))).toBe(false);
  });

  test("installs into every provider whose config directory exists", async () => {
    const fixtureOptions = await fixture();
    const { homeDirectory, sourcePath } = fixtureOptions;
    await Promise.all([
      mkdir(join(homeDirectory, ".claude")),
      mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true }),
      mkdir(join(homeDirectory, ".copilot")),
      mkdir(join(homeDirectory, ".codex")),
    ]);

    const installations = await installFleetSkill(fixtureOptions);
    const destinations = [
      join(homeDirectory, ".claude", "skills", "fleet-agent", "SKILL.md"),
      join(homeDirectory, ".config", "opencode", "skills", "fleet-agent", "SKILL.md"),
      join(homeDirectory, ".copilot", "skills", "fleet-agent", "SKILL.md"),
      join(homeDirectory, ".codex", "skills", "fleet-agent", "SKILL.md"),
      join(homeDirectory, ".agents", "skills", "fleet-agent", "SKILL.md"),
    ];

    expect(installations.map(({ provider, status }) => ({ provider, status }))).toEqual([
      { provider: "claude-code", status: "installed" },
      { provider: "opencode", status: "installed" },
      { provider: "copilot", status: "installed" },
      { provider: "codex", status: "installed" },
      { provider: "codex", status: "installed" },
    ]);
    for (const destination of destinations) {
      expect(await Bun.file(destination).text()).toBe(await Bun.file(sourcePath).text());
    }
  });

  test("installs the embedded skill source by default", async () => {
    const { homeDirectory } = await fixture();
    await mkdir(join(homeDirectory, ".claude"));

    const [installation] = await installFleetSkill({ homeDirectory, providers: ["claude-code"] });

    const skill = await Bun.file(installation!.path).text();
    expect(skill).toContain("name: fleet-agent");
    expect(skill).toContain("`fleet agent ...` is the only Fleet CLI namespace you may use");
    expect(skill).toContain("fleet agent init");
    expect(skill).toContain("fleet agent status");
    expect(skill).toContain("fleet agent in-workspace");
    expect(skill).not.toMatch(/fleet-agent (?:init|status|in-workspace)/);
    expect(await inspectFleetSkill({ homeDirectory, providers: ["claude-code"] })).toEqual([
      { provider: "claude-code", path: installation!.path, state: "current" },
    ]);
  });

  test("installs only for the providers that are present", async () => {
    const fixtureOptions = await fixture();
    const { homeDirectory } = fixtureOptions;
    await mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true });

    const installations = await installFleetSkill(fixtureOptions);

    expect(installations).toHaveLength(1);
    expect(installations[0]?.provider).toBe("opencode");
    expect(await exists(join(homeDirectory, ".claude"))).toBe(false);
    expect(await exists(join(homeDirectory, ".copilot"))).toBe(false);
    expect(await exists(join(homeDirectory, ".agents"))).toBe(false);
  });

  test("preserves unowned skills until forced, then leaves owned skills untouched", async () => {
    const fixtureOptions = await fixture();
    const destination = join(
      fixtureOptions.homeDirectory,
      ".claude",
      "skills",
      "fleet-agent",
      "SKILL.md",
    );
    await mkdir(join(destination, ".."), { recursive: true });
    await Bun.write(destination, "stale");

    const conflict = await installFleetSkill(fixtureOptions);
    expect(await Bun.file(destination).text()).toBe("stale");
    const updated = await installFleetSkill({ ...fixtureOptions, force: true });
    const unchanged = await installFleetSkill(fixtureOptions);

    expect(conflict[0]?.status).toBe("conflict");
    expect(updated[0]?.status).toBe("updated");
    expect(unchanged[0]?.status).toBe("unchanged");
    expect(await Bun.file(destination).text()).toBe(
      await Bun.file(fixtureOptions.sourcePath).text(),
    );
  });

  test("installs Codex skills to native and shared paths", async () => {
    const fixtureOptions = await fixture();
    const nativeDestination = join(
      fixtureOptions.homeDirectory,
      ".codex",
      "skills",
      "fleet-agent",
      "SKILL.md",
    );
    const sharedDestination = join(
      fixtureOptions.homeDirectory,
      ".agents",
      "skills",
      "fleet-agent",
      "SKILL.md",
    );
    await mkdir(join(fixtureOptions.homeDirectory, ".agents"));

    expect(await installFleetSkill(fixtureOptions)).toEqual([]);
    expect(await exists(nativeDestination)).toBe(false);
    expect(await exists(sharedDestination)).toBe(false);

    await mkdir(join(fixtureOptions.homeDirectory, ".codex"));
    const installations = await installFleetSkill(fixtureOptions);
    expect(installations.map(({ provider }) => provider)).toEqual(["codex", "codex"]);
    expect(await exists(nativeDestination)).toBe(true);
    expect(await exists(sharedDestination)).toBe(true);
  });

  test("does not write through a symlinked skill file", async () => {
    const fixtureOptions = await fixture();
    const skillDirectory = join(
      fixtureOptions.homeDirectory,
      ".claude",
      "skills",
      "fleet-agent",
    );
    const target = join(fixtureOptions.homeDirectory, "user-managed-skill.md");
    await mkdir(skillDirectory, { recursive: true });
    await Bun.write(target, "user managed");
    await symlink(target, join(skillDirectory, "SKILL.md"));

    await expect(installFleetSkill(fixtureOptions)).rejects.toThrow(
      "Failed to install fleet skill",
    );
    expect(await Bun.file(target).text()).toBe("user managed");
  });

  test("installs only the requested providers", async () => {
    const fixtureOptions = await fixture();
    const { homeDirectory } = fixtureOptions;
    await Promise.all([
      mkdir(join(homeDirectory, ".claude")),
      mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true }),
    ]);

    const installations = await installFleetSkill({ ...fixtureOptions, providers: ["opencode"] });

    expect(installations.map(({ provider }) => provider)).toEqual(["opencode"]);
    expect(
      await exists(join(homeDirectory, ".claude", "skills", "fleet-agent", "SKILL.md")),
    ).toBe(false);
  });

  test("inspectFleetSkill reports absent / missing / conflict-unmanaged / current", async () => {
    const fixtureOptions = await fixture();
    const { homeDirectory, sourcePath } = fixtureOptions;
    const source = await Bun.file(sourcePath).text();

    // absent: no config root at all yet.
    let statuses = await inspectFleetSkill(fixtureOptions);
    expect(statuses.every((status) => status.state === "absent")).toBe(true);

    // claude-code present but not installed → missing.
    await mkdir(join(homeDirectory, ".claude"));
    statuses = await inspectFleetSkill({ ...fixtureOptions, providers: ["claude-code"] });
    expect(statuses[0]?.state).toBe("missing");

    // install → current.
    await installFleetSkill({ ...fixtureOptions, providers: ["claude-code"] });
    statuses = await inspectFleetSkill({ ...fixtureOptions, providers: ["claude-code"] });
    expect(statuses[0]?.state).toBe("current");

    // A user edit no longer matches Fleet's recorded ownership hash.
    await Bun.write(statuses[0]!.path, `${source}drift`);
    statuses = await inspectFleetSkill({ ...fixtureOptions, providers: ["claude-code"] });
    expect(statuses[0]?.state).toBe("conflict-unmanaged");
  });
});
