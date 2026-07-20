/**
 * plugin-installer.ts — install the startup plugin/hook that tells an agent to
 * activate the `fleet-agent` skill when it boots inside a fleet workspace.
 *
 * Each supported provider's plugin runs the same logic — `fleet-agent
 * in-workspace`, and on success inject an "activate the fleet-agent skill"
 * instruction — but the packaging differs per provider:
 *
 *   - claude-code: a plugin directory tree auto-loaded from `~/.claude/skills/`
 *     (`.claude-plugin/plugin.json` + a SessionStart command hook).
 *   - opencode:    a single `session.start` plugin module auto-loaded from
 *     `~/.config/opencode/plugins/`.
 *   - copilot:     a single `sessionStart` hook JSON auto-loaded from
 *     `~/.copilot/hooks/`.
 *
 * All three install by mirroring source files into an auto-discovered location,
 * so they share one symlink-safe copy routine (see managed-fs.ts). Codex is not
 * handled here: it has no drop-in directory and requires the `codex plugin` CLI
 * plus a manual hook-trust step, so it can't be installed unattended — see
 * docs/codex.md.
 *
 * Source plugins live under `packages/fleet-ship/plugins/`.
 */

import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureManagedDirectory,
  isDirectory,
  syncManagedFile,
  type WriteStatus,
} from "./managed-fs";

const CLAUDE_PLUGIN_NAME = "fleet-agent-bootstrap";
const DEFAULT_PLUGINS_DIR = fileURLToPath(new URL("../plugins", import.meta.url));

type Provider = "claude-code" | "opencode" | "copilot";

export type PluginInstallation = {
  provider: Provider;
  path: string;
  status: WriteStatus;
};

export type InstallFleetPluginOptions = {
  homeDirectory?: string;
  pluginsDirectory?: string;
};

type FileMapping = { source: string; destination: string; executable: boolean };

type PluginSpec = {
  provider: Provider;
  configRoot: string;
  /** Where the plugin lives once installed — reported back to the caller. */
  path: string;
  /** Resolve the concrete source→destination files (a tree may fan out). */
  files: () => Promise<FileMapping[]>;
};

/** Map every file in a source directory tree onto the destination directory. */
async function treeFiles(sourceDir: string, destinationDir: string): Promise<FileMapping[]> {
  const mappings: FileMapping[] = [];
  for await (const relative of new Bun.Glob("**/*").scan({ cwd: sourceDir, dot: true })) {
    mappings.push({
      source: join(sourceDir, relative),
      destination: join(destinationDir, relative),
      // The hook is executed directly by the harness, so it must stay runnable.
      executable: relative.endsWith(".sh"),
    });
  }
  return mappings.sort((a, b) => a.destination.localeCompare(b.destination));
}

function pluginSpecs(homeDirectory: string, pluginsDir: string): PluginSpec[] {
  const claudeRoot = join(homeDirectory, ".claude", "skills", CLAUDE_PLUGIN_NAME);
  const openCodePlugin = join(homeDirectory, ".config", "opencode", "plugins", "fleet-agent.js");
  const copilotHook = join(homeDirectory, ".copilot", "hooks", "fleet-agent-session-start.json");

  return [
    {
      provider: "claude-code",
      configRoot: join(homeDirectory, ".claude"),
      path: claudeRoot,
      files: () => treeFiles(join(pluginsDir, "claude-code"), claudeRoot),
    },
    {
      provider: "opencode",
      configRoot: join(homeDirectory, ".config", "opencode"),
      path: openCodePlugin,
      files: async () => [
        { source: join(pluginsDir, "opencode.js"), destination: openCodePlugin, executable: false },
      ],
    },
    {
      provider: "copilot",
      configRoot: join(homeDirectory, ".copilot"),
      path: copilotHook,
      files: async () => [
        {
          source: join(pluginsDir, "copilot", "session-start-hook.json"),
          destination: copilotHook,
          executable: false,
        },
      ],
    },
  ];
}

/** Directories from just below `configRoot` down to `leaf` inclusive, shallowest first. */
function directoriesWithin(configRoot: string, leaf: string): string[] {
  const chain: string[] = [];
  let current = leaf;
  while (current.length > configRoot.length) {
    chain.push(current);
    current = dirname(current);
  }
  return chain.reverse();
}

/** Roll per-file statuses up into one: unchanged unless something moved; installed only if all-new. */
function overallStatus(statuses: WriteStatus[]): WriteStatus {
  if (statuses.every((status) => status === "unchanged")) return "unchanged";
  if (statuses.every((status) => status === "installed")) return "installed";
  return "updated";
}

async function installPlugin(spec: PluginSpec): Promise<PluginInstallation | undefined> {
  if (!(await isDirectory(spec.configRoot))) return undefined;

  const files = await spec.files();

  const directories = new Set<string>();
  for (const file of files) {
    for (const dir of directoriesWithin(spec.configRoot, dirname(file.destination))) {
      directories.add(dir);
    }
  }
  for (const dir of [...directories].sort((a, b) => a.length - b.length)) {
    await ensureManagedDirectory(dir);
  }

  const statuses: WriteStatus[] = [];
  for (const file of files) {
    const source = await Bun.file(file.source).text();
    statuses.push(await syncManagedFile(file.destination, source));
    if (file.executable) await chmod(file.destination, 0o755);
  }

  return { provider: spec.provider, path: spec.path, status: overallStatus(statuses) };
}

export async function installFleetPlugin(
  options: InstallFleetPluginOptions = {},
): Promise<PluginInstallation[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const pluginsDirectory = options.pluginsDirectory ?? DEFAULT_PLUGINS_DIR;
  const installations: PluginInstallation[] = [];
  const failures: Error[] = [];

  for (const spec of pluginSpecs(homeDirectory, pluginsDirectory)) {
    try {
      const installation = await installPlugin(spec);
      if (installation) installations.push(installation);
    } catch (error) {
      failures.push(
        new Error(`Failed to install fleet plugin for ${spec.provider}`, { cause: error }),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to install fleet plugin");
  }

  return installations;
}
