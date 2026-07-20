import { lstat, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "fleet-agent";
const DEFAULT_SOURCE_PATH = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));

type Provider = "claude-code" | "opencode" | "copilot" | "codex";

export type SkillInstallation = {
  provider: Provider;
  path: string;
  status: "installed" | "updated" | "unchanged";
};

export type InstallFleetSkillOptions = {
  homeDirectory?: string;
  sourcePath?: string;
};

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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function ensureManagedDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing to use non-directory skill path: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path);
  }
}

async function installForProvider(
  paths: ProviderPaths,
  source: string,
): Promise<SkillInstallation | undefined> {
  if (!(await isDirectory(paths.configRoot))) return undefined;

  for (const directory of paths.directories) await ensureManagedDirectory(directory);

  let previous: string | undefined;
  try {
    const entry = await lstat(paths.destination);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Refusing to replace non-file skill path: ${paths.destination}`);
    }
    previous = await Bun.file(paths.destination).text();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (previous === source) {
    return { provider: paths.provider, path: paths.destination, status: "unchanged" };
  }

  await Bun.write(paths.destination, source);
  return {
    provider: paths.provider,
    path: paths.destination,
    status: previous === undefined ? "installed" : "updated",
  };
}

export async function installFleetSkill(
  options: InstallFleetSkillOptions = {},
): Promise<SkillInstallation[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const sourcePath = options.sourcePath ?? DEFAULT_SOURCE_PATH;
  const source = await Bun.file(sourcePath).text();
  const installations: SkillInstallation[] = [];
  const failures: Error[] = [];

  for (const paths of providerPaths(homeDirectory)) {
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
