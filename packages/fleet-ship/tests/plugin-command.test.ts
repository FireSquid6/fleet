import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatDoctorReport, type CliStatus } from "../src/plugin-command";
import type { SkillStatus } from "../src/skill-installer";
import type { PluginStatus } from "../src/plugin-installer";

describe("formatDoctorReport", () => {
  const home = "/home/tester";

  const skills: SkillStatus[] = [
    { provider: "claude-code", path: join(home, ".claude/skills/fleet-agent/SKILL.md"), state: "current" },
    { provider: "opencode", path: join(home, ".config/opencode/skills/fleet-agent/SKILL.md"), state: "stale" },
    { provider: "copilot", path: join(home, ".copilot/skills/fleet-agent/SKILL.md"), state: "absent" },
    { provider: "codex", path: join(home, ".codex/skills/fleet-agent/SKILL.md"), state: "missing" },
    { provider: "codex", path: join(home, ".agents/skills/fleet-agent/SKILL.md"), state: "missing" },
  ];
  const plugins: PluginStatus[] = [
    { provider: "claude-code", path: join(home, ".claude/skills/fleet-agent-bootstrap"), state: "current" },
    { provider: "opencode", path: join(home, ".config/opencode/plugins/fleet-agent.js"), state: "missing" },
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
    expect(report).toContain("~ stale");
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
