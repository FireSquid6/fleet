/**
 * skill-installer.ts — install the `fleet-agent` SKILL.md into each agent
 * provider's skills directory.
 *
 * This module owns *skill* installation only. The startup plugins/hooks that
 * tell an agent to activate the skill live in plugin-installer.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
// TypeScript resolves the source extension before Bun's text-loader override.
// @ts-expect-error Bun imports this Markdown file as a string.
import embeddedSkill from "../skill/SKILL.md" with { type: "text" };
import {
  ensureManagedDirectory,
  inspectManagedFile,
  isDirectory,
  syncManagedFile,
  type PresenceState,
  type WriteStatus,
} from "./managed-fs";

const SKILL_NAME = "fleet-agent";

type Provider = "claude-code" | "opencode" | "copilot" | "codex";

export type SkillInstallation = {
  provider: Provider;
  path: string;
  status: WriteStatus;
};

export type SkillStatus = {
  provider: Provider;
  path: string;
  state: PresenceState;
};

export type InstallFleetSkillOptions = {
  homeDirectory?: string;
  sourcePath?: string;
  /** Restrict to these providers; omit to target all of them. */
  providers?: readonly string[];
};

export type InspectFleetSkillOptions = InstallFleetSkillOptions;

type ProviderPaths = {
  provider: Provider;
  configRoot: string;
  destination: string;
  directories: string[];
};

function providerPaths(homeDirectory: string): ProviderPaths[] {
  const claudeSkills = join(homeDirectory, ".claude", "skills");
  const openCodeSkills = join(homeDirectory, ".config", "opencode", "skills");
  const copilotSkills = join(homeDirectory, ".copilot", "skills");
  const codexSkills = join(homeDirectory, ".codex", "skills");
  const sharedSkills = join(homeDirectory, ".agents", "skills");

  return [
    {
      provider: "claude-code",
      configRoot: join(homeDirectory, ".claude"),
      destination: join(claudeSkills, SKILL_NAME, "SKILL.md"),
      directories: [claudeSkills, join(claudeSkills, SKILL_NAME)],
    },
    {
      provider: "opencode",
      configRoot: join(homeDirectory, ".config", "opencode"),
      destination: join(openCodeSkills, SKILL_NAME, "SKILL.md"),
      directories: [openCodeSkills, join(openCodeSkills, SKILL_NAME)],
    },
    {
      provider: "copilot",
      configRoot: join(homeDirectory, ".copilot"),
      destination: join(copilotSkills, SKILL_NAME, "SKILL.md"),
      directories: [copilotSkills, join(copilotSkills, SKILL_NAME)],
    },
    {
      provider: "codex",
      configRoot: join(homeDirectory, ".codex"),
      destination: join(codexSkills, SKILL_NAME, "SKILL.md"),
      directories: [codexSkills, join(codexSkills, SKILL_NAME)],
    },
    {
      provider: "codex",
      configRoot: join(homeDirectory, ".codex"),
      destination: join(sharedSkills, SKILL_NAME, "SKILL.md"),
      directories: [
        join(homeDirectory, ".agents"),
        sharedSkills,
        join(sharedSkills, SKILL_NAME),
      ],
    },
  ];
}

/** The provider spec rows to act on, optionally narrowed to `providers`. */
function selectedPaths(homeDirectory: string, providers?: readonly string[]): ProviderPaths[] {
  const all = providerPaths(homeDirectory);
  return providers ? all.filter((paths) => providers.includes(paths.provider)) : all;
}

async function installForProvider(
  paths: ProviderPaths,
  source: string,
): Promise<SkillInstallation | undefined> {
  if (!(await isDirectory(paths.configRoot))) return undefined;

  for (const directory of paths.directories) await ensureManagedDirectory(directory);

  return {
    provider: paths.provider,
    path: paths.destination,
    status: await syncManagedFile(paths.destination, source),
  };
}

export async function installFleetSkill(
  options: InstallFleetSkillOptions = {},
): Promise<SkillInstallation[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const source = options.sourcePath ? await Bun.file(options.sourcePath).text() : embeddedSkill;
  const installations: SkillInstallation[] = [];
  const failures: Error[] = [];

  for (const paths of selectedPaths(homeDirectory, options.providers)) {
    try {
      const installation = await installForProvider(paths, source);
      if (installation) installations.push(installation);
    } catch (error) {
      failures.push(
        new Error(`Failed to install fleet skill for ${paths.provider}`, { cause: error }),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to install fleet skill");
  }

  return installations;
}

/**
 * Report the install state of the skill for each provider spec row, without
 * writing anything. Codex contributes two rows (native + shared `~/.agents`).
 */
export async function inspectFleetSkill(
  options: InspectFleetSkillOptions = {},
): Promise<SkillStatus[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const source = options.sourcePath ? await Bun.file(options.sourcePath).text() : embeddedSkill;

  const statuses: SkillStatus[] = [];
  for (const paths of selectedPaths(homeDirectory, options.providers)) {
    const state: PresenceState = (await isDirectory(paths.configRoot))
      ? await inspectManagedFile(paths.destination, source)
      : "absent";
    statuses.push({ provider: paths.provider, path: paths.destination, state });
  }
  return statuses;
}
