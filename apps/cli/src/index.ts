#!/usr/bin/env bun
/**
 * index.ts — Fleet CLI entry point.
 *
 * A Commander.js CLI that drives a Fleet Ship host's HTTP API through a
 * type-safe Elysia Eden Treaty client (see client.ts). No terminal/websocket
 * command — that's deliberately out of scope here.
 */

import { Command } from "commander";
import {
  ARMORY_SECTIONS,
  DEFAULT_PORT,
  type ArmoryFile,
  type ArmoryManifest,
  type ArmorySection,
  type Repo,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "fleet-protocol";
import type { ShipInfo, BridgeWorkspaceSummary, ShipArmoryState } from "fleet-bridge/types";
import { makeBridgeClient, makeClient, normalizeUrl, unwrap } from "./client";
import {
  abbreviateRevision,
  formatArmoryShipTable,
  formatArmoryTable,
  formatFleetWorkspaceTable,
  formatRepoTable,
  formatShipTable,
  formatWorkspaceTable,
} from "./format";
import { ship } from "fleet-ship";
import { bridge } from "fleet-bridge";
import { startClientServer } from "fleet-client";
import { launchCommand } from "./launch-command";
import { attachToWorkspace } from "./attach";


const clientCommand = new Command()
  .name("client")
  .description("Client subcommand")
  .option("--url <baseUrl>", "base URL of the Fleet Ship host", `http://localhost:${DEFAULT_PORT}`)
  .option("--bridge-url <url>", "base URL of the Fleet Bridge (fleet-wide commands)", "http://localhost:4800");

function client() {
  const opts = clientCommand.opts<{ url: string }>();
  return makeClient(normalizeUrl(opts.url));
}

function bridgeClient() {
  const opts = clientCommand.opts<{ bridgeUrl: string }>();
  return makeBridgeClient(normalizeUrl(opts.bridgeUrl));
}

clientCommand
  .command("ls")
  .description("list workspaces (a single ship, or the whole fleet with --wide)")
  .option("--active", "only show active workspaces")
  .option("--inactive", "only show inactive workspaces")
  .option("--wide", "list every workspace across the fleet (via the bridge), with its ship")
  .option("--json", "output as JSON")
  .action(async (options: { active?: boolean; inactive?: boolean; wide?: boolean; json?: boolean }) => {
    if (options.active && options.inactive) {
      console.error("fleet: --active and --inactive are mutually exclusive");
      process.exit(1);
    }

    const query =
      options.active ? { active: "true" as const } : options.inactive ? { active: "false" as const } : {};

    if (options.wide) {
      const rows = unwrap(await bridgeClient().workspaces.get({ query })) as BridgeWorkspaceSummary[];
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log("no workspaces");
      } else {
        console.log(formatFleetWorkspaceTable(rows));
      }
      return;
    }

    const rows = unwrap(await client().workspaces.get({ query })) as WorkspaceSummary[];
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log("no workspaces");
    } else {
      console.log(formatWorkspaceTable(rows));
    }
  });

clientCommand
  .command("status")
  .description("show detailed status for a workspace")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).get();
    const status = unwrap(result) as WorkspaceStatus;

    console.log(`repo:   ${status.repoName}`);
    console.log(`name:   ${status.name}`);
    console.log(`branch: ${status.branch}`);
    console.log(`state:  ${status.state}`);

    if (status.state === "active") {
      console.log(`ship:   ${status.ship}`);
      console.log(
        `diff:   +${status.diff.added} -${status.diff.removed} (${status.diff.commits} commit${status.diff.commits === 1 ? "" : "s"} ahead)`,
      );
    }
  });

clientCommand
  .command("create")
  .description("create a new workspace by cloning a repo/branch")
  .argument("<repoName>", "repo name (the directory the clone lands under)")
  .argument("<name>", "workspace name")
  .requiredOption("-u, --url <url>", "git clone URL")
  .requiredOption("-b, --branch <branch>", "branch to check out")
  .action(async (repoName: string, name: string, options: { url: string; branch: string }) => {
    const result = await client().workspaces.post({
      url: options.url,
      repoName,
      name,
      branch: options.branch,
    });
    const summary = unwrap(result) as WorkspaceSummary;

    console.log(`created workspace ${summary.repoName}/${summary.name} on branch ${summary.branch}`);
  });

clientCommand
  .command("branch")
  .description("switch (and create if needed) the branch of a workspace")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .argument("<newBranch>", "branch to switch to")
  .action(async (repo: string, name: string, newBranch: string) => {
    const result = await client().workspaces({ repo })({ name }).branch.post({ branch: newBranch });
    unwrap(result);

    console.log(`switched ${repo}/${name} to branch ${newBranch}`);
  });

clientCommand
  .command("activate")
  .description("activate a workspace (start its tmux session)")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).activate.post();
    unwrap(result);

    console.log(`activated ${repo}/${name}`);
  });

clientCommand
  .command("deactivate")
  .description("deactivate a workspace (stop its tmux session)")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).deactivate.post();
    unwrap(result);

    console.log(`deactivated ${repo}/${name}`);
  });

clientCommand
  .command("attach")
  .description("attach to a workspace's terminal (Ctrl-] to detach)")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const { url } = clientCommand.opts<{ url: string }>();
    const code = await attachToWorkspace(normalizeUrl(url), repo, name);
    process.exit(code);
  });

clientCommand
  .command("rm")
  .description("delete a workspace")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).delete();
    unwrap(result);

    console.log(`removed ${repo}/${name}`);
  });

const shipsCommand = new Command().name("ships").description("manage the fleet's ships (via the bridge)");

shipsCommand
  .command("ls")
  .description("list the ships registered with the bridge")
  .option("--json", "output as JSON")
  .action(async (options: { json?: boolean }) => {
    const rows = unwrap(await bridgeClient().ships.get()) as ShipInfo[];
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log("no ships");
    } else {
      console.log(formatShipTable(rows));
    }
  });

shipsCommand
  .command("add")
  .description("register a ship by its URL (the bridge discovers its name)")
  .argument("<url>", "base URL of the ship host")
  .action(async (url: string) => {
    const created = unwrap(await bridgeClient().ships.post({ url: normalizeUrl(url) })) as ShipInfo;
    console.log(`registered ship ${created.name} (${created.url})`);
  });

shipsCommand
  .command("rm")
  .description("deregister a ship")
  .argument("<name>", "ship name")
  .action(async (name: string) => {
    unwrap(await bridgeClient().ships({ name }).delete());
    console.log(`removed ship ${name}`);
  });

clientCommand.addCommand(shipsCommand);

const reposCommand = new Command().name("repos").description("manage the fleet's repos (via the bridge)");

reposCommand
  .command("ls")
  .description("list the repos registered with the bridge")
  .option("--json", "output as JSON")
  .action(async (options: { json?: boolean }) => {
    const rows = unwrap(await bridgeClient().repos.get()) as Repo[];
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log("no repos");
    } else {
      console.log(formatRepoTable(rows));
    }
  });

reposCommand
  .command("add")
  .description("register a repo")
  .argument("<name>", "repo name (the directory a clone lands under on the ship)")
  .argument("<url>", "git clone URL")
  .option("-p, --provider <provider>", "where the repo is hosted (e.g. github)")
  .action(async (name: string, url: string, options: { provider?: string }) => {
    const repo = unwrap(await bridgeClient().repos.post({ name, url, provider: options.provider })) as Repo;
    console.log(`registered repo ${repo.name} (${repo.url})`);
  });

reposCommand
  .command("rm")
  .description("deregister a repo")
  .argument("<name>", "repo name")
  .action(async (name: string) => {
    unwrap(await bridgeClient().repos({ name }).delete());
    console.log(`removed repo ${name}`);
  });

clientCommand.addCommand(reposCommand);

const armoryCommand = new Command()
  .name("armory")
  .description("inspect the fleet's armory (via the bridge); read-only");

armoryCommand
  .command("ls")
  .description("list the files the bridge's armory holds")
  .option("--json", "output as JSON")
  .option("--section <section>", `only files in one section (${ARMORY_SECTIONS.join(", ")})`)
  .action(async (options: { json?: boolean; section?: string }) => {
    const section = options.section;
    if (section !== undefined && !ARMORY_SECTIONS.includes(section as ArmorySection)) {
      console.error(`fleet: unknown section "${section}"; expected one of: ${ARMORY_SECTIONS.join(", ")}`);
      process.exit(1);
    }

    const manifest = unwrap(await bridgeClient().armory.get()) as ArmoryManifest;
    const entries = section
      ? manifest.entries.filter((entry) => entry.section === section)
      : manifest.entries;

    if (options.json) {
      console.log(JSON.stringify({ ...manifest, entries }, null, 2));
    } else if (entries.length === 0) {
      console.log("no armory files");
    } else {
      console.log(
        `revision ${abbreviateRevision(manifest.revision)} (${entries.length} file${entries.length === 1 ? "" : "s"})`,
      );
      console.log(formatArmoryTable(entries));
    }
  });

armoryCommand
  .command("cat")
  .description("print an armory file's contents")
  .argument("<path>", "armory-relative path, e.g. skills/my-skill/SKILL.md")
  .action(async (path: string) => {
    const file = unwrap(await bridgeClient().armory.file.get({ query: { path } })) as ArmoryFile;

    // Binary bytes re-encoded through stdout would arrive mangled, and a
    // redirect would capture that silently — refuse rather than hand back a
    // corrupt file.
    if (file.encoding === "base64") {
      console.error(
        `fleet: ${file.path} is binary (${file.size} bytes, sha256 ${file.sha256}); not writing it to stdout`,
      );
      process.exit(1);
    }

    process.stdout.write(file.contents);
  });

armoryCommand
  .command("ships")
  .description("show what each ship has pulled and installed from the armory")
  .option("--json", "output as JSON")
  .action(async (options: { json?: boolean }) => {
    const rows = unwrap(await bridgeClient().armory.ships.get()) as ShipArmoryState[];
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("no ships");
      return;
    }

    const manifest = unwrap(await bridgeClient().armory.get()) as ArmoryManifest;
    console.log(formatArmoryShipTable(manifest.revision, rows));

    for (const row of rows) {
      const install = row.state?.install;
      const problems = [
        ...(row.state?.lastError ? [`error: ${row.state.lastError}`] : []),
        ...(install?.conflicts ?? []).map((conflict) => `conflict: ${conflict}`),
        ...(install?.warnings ?? []).map((warning) => `warning: ${warning}`),
      ];
      if (problems.length === 0) continue;

      console.log("");
      console.log(`${row.ship}:`);
      for (const problem of problems) console.log(`  ${problem}`);
    }
  });

clientCommand.addCommand(armoryCommand);

clientCommand
  .command("serve")
  .description("Serve the client web ui")
  .option("--url <bridgeUrl>", "URL of the bridge to proxy to", `http://localhost:4800`)
  .action((options: { url: string }) => {
    startClientServer(normalizeUrl(options.url));
  })


const mainCommand = new Command().name("fleet");

mainCommand.addCommand(clientCommand);
mainCommand.addCommand(ship);
mainCommand.addCommand(bridge);
mainCommand.addCommand(launchCommand);

mainCommand.parseAsync(process.argv);
