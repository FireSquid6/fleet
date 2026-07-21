import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatDoctorReport, performPluginInstall, type CliStatus } from "../src/plugin-command";
import type { SkillStatus } from "../src/skill-installer";
import type { PluginStatus } from "../src/plugin-installer";

describe("formatDoctorReport", () => {
  const home = "/home/tester";

  const skills: SkillStatus[] = [
    { provider: "claude-code", path: join(home, ".claude/skills/fleet-agent/SKILL.md"), state: "current" },
    { provider: "opencode", path: join(home, ".config/opencode/skills/fleet-agent/SKILL.md"), state: "outdated-owned" },
    { provider: "copilot", path: join(home, ".copilot/skills/fleet-agent/SKILL.md"), state: "absent" },
    { provider: "codex", path: join(home, ".codex/skills/fleet-agent/SKILL.md"), state: "missing" },
    { provider: "codex", path: join(home, ".agents/skills/fleet-agent/SKILL.md"), state: "missing" },
  ];
  const plugins: PluginStatus[] = [
    { provider: "claude-code", path: join(home, ".claude/skills/fleet-agent-bootstrap"), state: "current" },
    { provider: "opencode", path: join(home, ".config/opencode/plugins/fleet-agent.js"), state: "conflict-unmanaged" },
    { provider: "copilot", path: join(home, ".copilot/hooks/fleet-agent-session-start.json"), state: "absent" },
  ];
  const clis: CliStatus[] = [
    { provider: "claude-code", binary: "claude", path: "/usr/local/bin/claude" },
    { provider: "opencode", binary: "opencode", path: null },
    { provider: "copilot", binary: "copilot", path: null },
    { provider: "codex", binary: "codex", path: "/opt/codex/bin/codex" },
  ];

  const report = formatDoctorReport(skills, plugins, clis, home);

  test("shortens home paths to ~", () => {
    expect(report).toContain("~/.claude/skills/fleet-agent/SKILL.md");
    expect(report).not.toContain("/home/tester");
  });

  test("groups every provider in a fixed order", () => {
    const order = ["claude-code", "opencode", "copilot", "codex"].map((p) => report.indexOf(`\n${p}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  test("shows both codex skill rows, flagging the shared one, and no codex plugin", () => {
    expect(report).toContain("(shared)");
    expect(report).toContain("no startup plugin for this provider");
  });

  test("renders each state's label", () => {
    expect(report).toContain("✓ current");
    expect(report).toContain("~ outdated-owned");
    expect(report).toContain("! conflict/unmanaged");
    expect(report).toContain("✗ missing");
    expect(report).toContain("- absent");
  });

  test("reports whether each provider's CLI is on PATH", () => {
    expect(report).toContain("✓ found");
    expect(report).toContain("claude → /usr/local/bin/claude");
    expect(report).toContain("✗ not found");
    expect(report).toContain("opencode (not on PATH)");
  });
});

describe("performPluginInstall", () => {
  test("forwards force and reports exact conflict paths with a failing result", async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const conflictPath = "/home/tester/.config/opencode/plugins/fleet-agent.js";

    const result = await performPluginInstall(
      "opencode",
      true,
      { log: (message) => logs.push(message), error: (message) => errors.push(message) },
      {
        skill: async (options) => {
          calls.push(options);
          return [];
        },
        plugin: async (options) => {
          calls.push(options);
          return [{
            provider: "opencode",
            path: conflictPath,
            status: "conflict",
            conflictPaths: [conflictPath],
          }];
        },
      },
    );

    expect(calls).toEqual([
      { providers: ["opencode"], force: true },
      { providers: ["opencode"], force: true },
    ]);
    expect(result.conflicts).toBe(1);
    expect(logs.join("\n")).toContain("conflict");
    expect(errors[0]).toContain(conflictPath);
    expect(errors[0]).toContain("fleet ship plugin install opencode --force");
  });

  test("does not swallow explicit CLI installer failures", async () => {
    await expect(
      performPluginInstall(
        "opencode",
        false,
        { log: () => {}, error: () => {} },
        {
          skill: async () => {
            throw new Error("skill installer failed");
          },
          plugin: async () => [],
        },
      ),
    ).rejects.toThrow("skill installer failed");

    await expect(
      performPluginInstall(
        "opencode",
        false,
        { log: () => {}, error: () => {} },
        {
          skill: async () => [],
          plugin: async () => {
            throw new Error("plugin installer failed");
          },
        },
      ),
    ).rejects.toThrow("plugin installer failed");
  });
});
