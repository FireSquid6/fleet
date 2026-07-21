/**
 * plugin-installer.ts — install the startup plugin/hook that tells an agent to
 * activate the `fleet-agent` skill when it boots inside a fleet workspace.
 *
 * Each supported provider's plugin runs the same logic — `fleet agent
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

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import claudeManifest from "../plugins/claude-code/.claude-plugin/plugin.json" with { type: "text" };
import claudeHooks from "../plugins/claude-code/hooks/hooks.json" with { type: "text" };
// TypeScript resolves the source extension before Bun's text-loader override.
// @ts-expect-error Bun imports this shell script as a string.
import claudeActivationHook from "../plugins/claude-code/hooks/activate-fleet-skill.sh" with {
  type: "text",
};
import copilotHookSource from "../plugins/copilot/session-start-hook.json" with { type: "text" };
// @ts-expect-error Bun imports this module's source text rather than its exports.
import openCodePluginSource from "../plugins/opencode.js" with { type: "text" };
import {
  ensureSafeDirectory,
  inspectManagedFile,
  isDirectory,
  withManagedFiles,
  type ManagedFileSession,
  type PresenceState,
  type WriteStatus,
} from "./managed-fs";

const CLAUDE_PLUGIN_NAME = "fleet-agent-bootstrap";

type Provider = "claude-code" | "opencode" | "copilot";

export type PluginInstallation = {
  provider: Provider;
  path: string;
  status: WriteStatus;
  conflictPaths?: string[];
};

export type PluginStatus = {
  provider: Provider;
  path: string;
  state: PresenceState;
};

export type InstallFleetPluginOptions = {
  homeDirectory?: string;
  pluginsDirectory?: string;
  /** Restrict to these providers; omit to target all of them. */
  providers?: readonly string[];
  force?: boolean;
};

export type InspectFleetPluginOptions = InstallFleetPluginOptions;

type FileMapping = {
  contents: () => Promise<string>;
  destination: string;
  mode: number;
};

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
      contents: () => Bun.file(join(sourceDir, relative)).text(),
      destination: join(destinationDir, relative),
      // The hook is executed directly by the harness, so it must stay runnable.
      mode: relative.endsWith(".sh") ? 0o755 : 0o644,
    });
  }
  return mappings.sort((a, b) => a.destination.localeCompare(b.destination));
}

function pluginSpecs(homeDirectory: string, pluginsDir?: string): PluginSpec[] {
  const claudeRoot = join(homeDirectory, ".claude", "skills", CLAUDE_PLUGIN_NAME);
  const openCodePlugin = join(homeDirectory, ".config", "opencode", "plugins", "fleet-agent.js");
  const copilotHook = join(homeDirectory, ".copilot", "hooks", "fleet-agent-session-start.json");

  return [
    {
      provider: "claude-code",
      configRoot: join(homeDirectory, ".claude"),
      path: claudeRoot,
      files: () =>
        pluginsDir
          ? treeFiles(join(pluginsDir, "claude-code"), claudeRoot)
          : Promise.resolve([
              {
                contents: async () => claudeManifest as unknown as string,
                destination: join(claudeRoot, ".claude-plugin", "plugin.json"),
                mode: 0o644,
              },
              {
                contents: async () => claudeHooks as unknown as string,
                destination: join(claudeRoot, "hooks", "hooks.json"),
                mode: 0o644,
              },
              {
                contents: async () => claudeActivationHook,
                destination: join(claudeRoot, "hooks", "activate-fleet-skill.sh"),
                mode: 0o755,
              },
            ]),
    },
    {
      provider: "opencode",
      configRoot: join(homeDirectory, ".config", "opencode"),
      path: openCodePlugin,
      files: async () => [
        {
          contents: pluginsDir
            ? () => Bun.file(join(pluginsDir, "opencode.js")).text()
            : async () => openCodePluginSource,
          destination: openCodePlugin,
          mode: 0o644,
        },
      ],
    },
    {
      provider: "copilot",
      configRoot: join(homeDirectory, ".copilot"),
      path: copilotHook,
      files: async () => [
        {
          contents: pluginsDir
            ? () => Bun.file(join(pluginsDir, "copilot", "session-start-hook.json")).text()
            : async () => copilotHookSource as unknown as string,
          destination: copilotHook,
          mode: 0o644,
        },
      ],
    },
  ];
}

/** The plugin specs to act on, optionally narrowed to `providers`. */
function selectedSpecs(
  homeDirectory: string,
  pluginsDir?: string,
  providers?: readonly string[],
): PluginSpec[] {
  const all = pluginSpecs(homeDirectory, pluginsDir);
  return providers ? all.filter((spec) => providers.includes(spec.provider)) : all;
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
  if (statuses.some((status) => status === "conflict")) return "conflict";
  if (statuses.every((status) => status === "unchanged")) return "unchanged";
  if (statuses.every((status) => status === "installed")) return "installed";
  if (statuses.every((status) => status === "adopted")) return "adopted";
  return "updated";
}

/** Surface the provider's most actionable per-file state in doctor output. */
function overallPresence(states: Array<Exclude<PresenceState, "absent">>): PresenceState {
  if (states.some((state) => state === "conflict-unmanaged")) return "conflict-unmanaged";
  if (states.some((state) => state === "missing")) return "missing";
  if (states.some((state) => state === "outdated-owned")) return "outdated-owned";
  if (states.every((state) => state === "current")) return "current";
  return "outdated-owned";
}

async function installPlugin(
  homeDirectory: string,
  spec: PluginSpec,
  session: ManagedFileSession,
  force: boolean,
): Promise<PluginInstallation | undefined> {
  if (!(await isDirectory(spec.configRoot))) return undefined;

  const files = await spec.files();

  const directories = new Set<string>();
  for (const file of files) {
    for (const dir of directoriesWithin(spec.configRoot, dirname(file.destination))) {
      directories.add(dir);
    }
  }
  for (const dir of [...directories].sort((a, b) => a.length - b.length)) {
    await ensureSafeDirectory(homeDirectory, dir);
  }

  const statuses: WriteStatus[] = [];
  const conflictPaths: string[] = [];
  for (const file of files) {
    const source = await file.contents();
    const status = await session.sync(file.destination, source, {
      provider: spec.provider,
      kind: "plugin",
      force,
      mode: file.mode,
    });
    statuses.push(status);
    if (status === "conflict") conflictPaths.push(file.destination);
  }

  return {
    provider: spec.provider,
    path: spec.path,
    status: overallStatus(statuses),
    ...(conflictPaths.length > 0 ? { conflictPaths } : {}),
  };
}

export async function installFleetPlugin(
  options: InstallFleetPluginOptions = {},
): Promise<PluginInstallation[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const pluginsDirectory = options.pluginsDirectory;
  const installations: PluginInstallation[] = [];
  const failures: Error[] = [];
  const specs = selectedSpecs(homeDirectory, pluginsDirectory, options.providers);
  const available: PluginSpec[] = [];

  for (const spec of specs) {
    if (await isDirectory(spec.configRoot)) available.push(spec);
  }
  if (available.length === 0) return [];

  await withManagedFiles(homeDirectory, async (session) => {
    for (const spec of available) {
      try {
        const installation = await installPlugin(
          homeDirectory,
          spec,
          session,
          options.force ?? false,
        );
        if (installation) installations.push(installation);
      } catch (error) {
        failures.push(
          new Error(`Failed to install fleet plugin for ${spec.provider}`, { cause: error }),
        );
      }
    }
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to install fleet plugin");
  }

  return installations;
}

/**
 * Report the install state of the plugin for each provider, without writing.
 * A provider's files are aggregated into a single state. Codex isn't included —
 * it has no drop-in plugin (see the module header).
 */
export async function inspectFleetPlugin(
  options: InspectFleetPluginOptions = {},
): Promise<PluginStatus[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const pluginsDirectory = options.pluginsDirectory;

  const statuses: PluginStatus[] = [];
  for (const spec of selectedSpecs(homeDirectory, pluginsDirectory, options.providers)) {
    let state: PresenceState;
    if (!(await isDirectory(spec.configRoot))) {
      state = "absent";
    } else {
      const files = await spec.files();
      const fileStates = await Promise.all(
        files.map(async (file) =>
          inspectManagedFile(homeDirectory, file.destination, await file.contents(), file.mode),
        ),
      );
      state = overallPresence(fileStates);
    }
    statuses.push({ provider: spec.provider, path: spec.path, state });
  }
  return statuses;
}
