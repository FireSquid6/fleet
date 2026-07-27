/**
 * skill-installer.ts — install the `fleet-agent` SKILL.md into each agent
 * provider's skills directory.
 *
 * This module owns *skill* installation only. The startup plugins/hooks that
 * tell an agent to activate the skill live in plugin-installer.ts.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
// TypeScript resolves the source extension before Bun's text-loader override.
// @ts-expect-error Bun imports this Markdown file as a string.
import embeddedSkill from "../skill/SKILL.md" with { type: "text" };
import {
  ensureSafeDirectory,
  inspectManagedFile,
  isDirectory,
  withManagedFiles,
  type ManagedFileSession,
  type PresenceState,
  type WriteStatus,
} from "./managed-fs";
import { PROVIDERS, configRootFor, skillRootsFor, type Provider } from "./providers";

const SKILL_NAME = "fleet-agent";

export type { Provider };

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
  force?: boolean;
};

export type InspectFleetSkillOptions = InstallFleetSkillOptions;

type ProviderPaths = {
  provider: Provider;
  configRoot: string;
  destination: string;
  directories: string[];
};

/** One row per (provider, skills directory): codex contributes two. */
function providerPaths(homeDirectory: string): ProviderPaths[] {
  return PROVIDERS.flatMap((provider) =>
    skillRootsFor(homeDirectory, provider).map((skillRoot) => ({
      provider,
      configRoot: configRootFor(homeDirectory, provider),
      destination: join(skillRoot, SKILL_NAME, "SKILL.md"),
      // `dirname(skillRoot)` is the provider's config root for its own skills
      // directory, but `~/.agents` for the shared one, which nothing else
      // creates.
      directories: [dirname(skillRoot), skillRoot, join(skillRoot, SKILL_NAME)],
    })),
  );
}

/** The provider spec rows to act on, optionally narrowed to `providers`. */
function selectedPaths(homeDirectory: string, providers?: readonly string[]): ProviderPaths[] {
  const all = providerPaths(homeDirectory);
  return providers ? all.filter((paths) => providers.includes(paths.provider)) : all;
}

async function installForProvider(
  homeDirectory: string,
  paths: ProviderPaths,
  source: string,
  session: ManagedFileSession,
  force: boolean,
): Promise<SkillInstallation | undefined> {
  if (!(await isDirectory(paths.configRoot))) return undefined;

  for (const directory of paths.directories) await ensureSafeDirectory(homeDirectory, directory);

  return {
    provider: paths.provider,
    path: paths.destination,
    status: await session.sync(paths.destination, source, {
      provider: paths.provider,
      kind: "skill",
      force,
      mode: 0o644,
    }),
  };
}

export async function installFleetSkill(
  options: InstallFleetSkillOptions = {},
): Promise<SkillInstallation[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const source = options.sourcePath ? await Bun.file(options.sourcePath).text() : embeddedSkill;
  const installations: SkillInstallation[] = [];
  const failures: Error[] = [];
  const pathsToInstall = selectedPaths(homeDirectory, options.providers);

  const available: ProviderPaths[] = [];
  for (const paths of pathsToInstall) {
    if (await isDirectory(paths.configRoot)) available.push(paths);
  }
  if (available.length === 0) return [];

  await withManagedFiles(homeDirectory, async (session) => {
    for (const paths of available) {
      try {
        const installation = await installForProvider(
          homeDirectory,
          paths,
          source,
          session,
          options.force ?? false,
        );
        if (installation) installations.push(installation);
      } catch (error) {
        failures.push(
          new Error(`Failed to install fleet skill for ${paths.provider}`, { cause: error }),
        );
      }
    }
  });

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
      ? await inspectManagedFile(homeDirectory, paths.destination, source, 0o644)
      : "absent";
    statuses.push({ provider: paths.provider, path: paths.destination, state });
  }
  return statuses;
}
