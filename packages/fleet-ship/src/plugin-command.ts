/**
 * plugin-command.ts — the `ship plugin` command group.
 *
 * `doctor` reports, read-only, the install state of the fleet-agent skill and
 * the startup plugin for every provider. `install <provider|all>` (re)installs
 * both the skill and the plugin for one provider or all of them, reusing the
 * same installers the ship runs on boot.
 */

import { homedir } from "node:os";
import { Command } from "commander";
import {
  installFleetSkill,
  inspectFleetSkill,
  type SkillInstallation,
  type SkillStatus,
} from "./skill-installer";
import {
  installFleetPlugin,
  inspectFleetPlugin,
  type PluginInstallation,
  type PluginStatus,
} from "./plugin-installer";
import type { PresenceState } from "./managed-fs";

/** Providers a user may pass to `install`; codex has a skill but no plugin. */
const PROVIDERS = ["claude-code", "opencode", "copilot", "codex"] as const;

/** Display order for `doctor`, matching PROVIDERS. */
const DISPLAY_ORDER = PROVIDERS;

/** The command each provider's harness is invoked as — what a skill/plugin is useless without. */
const PROVIDER_CLI: Record<(typeof PROVIDERS)[number], string> = {
  "claude-code": "claude",
  opencode: "opencode",
  copilot: "copilot",
  codex: "codex",
};

export type CliStatus = {
  provider: string;
  binary: string;
  /** Resolved path on PATH, or `null` when the CLI isn't installed. */
  path: string | null;
};

type InstallDependencies = {
  skill: typeof installFleetSkill;
  plugin: typeof installFleetPlugin;
};

type InstallOutput = {
  log(message: string): void;
  error(message: string): void;
};

export async function performPluginInstall(
  provider: string,
  force: boolean,
  output: InstallOutput = console,
  dependencies: InstallDependencies = { skill: installFleetSkill, plugin: installFleetPlugin },
): Promise<{ skills: SkillInstallation[]; plugins: PluginInstallation[]; conflicts: number }> {
  const providers = provider === "all" ? undefined : [provider];
  const skills = await dependencies.skill({ providers, force });
  const plugins = await dependencies.plugin({ providers, force });

  for (const skill of skills) {
    output.log(`skill   ${skill.provider.padEnd(12)} ${skill.status.padEnd(9)} ${skill.path}`);
  }
  for (const plugin of plugins) {
    output.log(`plugin  ${plugin.provider.padEnd(12)} ${plugin.status.padEnd(9)} ${plugin.path}`);
  }

  const conflicts = [
    ...skills
      .filter((installation) => installation.status === "conflict")
      .map((installation) => ({ provider: installation.provider, path: installation.path })),
    ...plugins.flatMap((installation) =>
      (installation.conflictPaths ?? []).map((path) => ({
        provider: installation.provider,
        path,
      })),
    ),
  ];
  for (const conflict of conflicts) {
    output.error(
      `Conflict: ${conflict.path} is user-managed or was modified; preserved. ` +
        `Review it, then run fleet ship plugin install ${conflict.provider} --force to replace it.`,
    );
  }
  return { skills, plugins, conflicts: conflicts.length };
}

/** Locate each provider's CLI on PATH. Impure (reads PATH); the formatter takes the result. */
export function inspectProviderClis(): CliStatus[] {
  return PROVIDERS.map((provider) => {
    const binary = PROVIDER_CLI[provider];
    return { provider, binary, path: Bun.which(binary) };
  });
}

const STATE_LABEL: Record<PresenceState, string> = {
  current: "✓ current",
  "outdated-owned": "~ outdated-owned",
  "conflict-unmanaged": "! conflict/unmanaged",
  missing: "✗ missing",
  absent: "- absent",
};

function shorten(path: string, homeDirectory: string): string {
  return path.startsWith(homeDirectory) ? `~${path.slice(homeDirectory.length)}` : path;
}

function row(kind: string, label: string, detail: string): string {
  return `  ${kind.padEnd(7)}${label.padEnd(11)}${detail}`;
}

/** Render a read-only status report grouped by provider. Pure — used by tests. */
export function formatDoctorReport(
  skills: SkillStatus[],
  plugins: PluginStatus[],
  clis: CliStatus[],
  homeDirectory: string,
): string {
  const lines: string[] = ["fleet-agent skill & plugin status", ""];

  for (const provider of DISPLAY_ORDER) {
    lines.push(provider);

    const cli = clis.find((entry) => entry.provider === provider);
    if (cli) {
      const label = cli.path ? "✓ found" : "✗ not found";
      const detail = cli.path ? `${cli.binary} → ${shorten(cli.path, homeDirectory)}` : `${cli.binary} (not on PATH)`;
      lines.push(row("cli", label, detail));
    }

    const providerSkills = skills.filter((skill) => skill.provider === provider);
    for (const skill of providerSkills) {
      // Codex contributes two skill rows; flag the shared `~/.agents` one.
      const suffix = skill.path.includes(".agents") ? "  (shared)" : "";
      lines.push(row("skill", STATE_LABEL[skill.state], shorten(skill.path, homeDirectory) + suffix));
    }

    const plugin = plugins.find((entry) => entry.provider === provider);
    if (plugin) {
      lines.push(row("plugin", STATE_LABEL[plugin.state], shorten(plugin.path, homeDirectory)));
    } else {
      lines.push(row("plugin", "n/a", "no startup plugin for this provider"));
    }
  }

  return lines.join("\n");
}

export const pluginCommand = new Command()
  .name("plugin")
  .description("manage the fleet-agent skill and startup plugins");

pluginCommand
  .command("doctor")
  .description("show the install status of the fleet-agent skill and plugin per provider")
  .action(async () => {
    const [skills, plugins] = await Promise.all([inspectFleetSkill(), inspectFleetPlugin()]);
    console.log(formatDoctorReport(skills, plugins, inspectProviderClis(), homedir()));
  });

pluginCommand
  .command("install")
  .description("install the fleet-agent skill and plugin for a provider")
  .argument("<provider>", `provider to install for, or "all" (${PROVIDERS.join(", ")})`)
  .option("--force", "replace conflicting regular files and claim them for Fleet")
  .action(async (provider: string, options: { force?: boolean }) => {
    if (provider !== "all" && !(PROVIDERS as readonly string[]).includes(provider)) {
      console.error(`unknown provider "${provider}"; expected one of: ${PROVIDERS.join(", ")}, all`);
      process.exit(1);
    }

    const result = await performPluginInstall(provider, options.force ?? false);
    if (result.conflicts > 0) process.exitCode = 1;

    if (provider !== "all" && result.skills.length === 0 && result.plugins.length === 0) {
      console.log(`${provider}: not installed on this machine (config directory missing); nothing to do.`);
    }
  });
