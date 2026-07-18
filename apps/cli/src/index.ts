#!/usr/bin/env bun
/**
 * index.ts — Fleet CLI entry point.
 *
 * A Commander.js CLI that drives a Fleet Ship host's HTTP API through a
 * type-safe Elysia Eden Treaty client (see client.ts). No terminal/websocket
 * command — that's deliberately out of scope here.
 */

import { Command } from "commander";
import { DEFAULT_PORT, type WorkspaceStatus, type WorkspaceSummary } from "fleet-protocol";
import { makeClient, normalizeUrl, unwrap } from "./client";
import { formatWorkspaceTable } from "./format";
import { ship } from "fleet-ship";
import { bridge } from "fleet-bridge";
import { startClientServer } from "fleet-client";


const clientCommand = new Command()
  .name("client")
  .description("Client subcommand")
  .option("--url <baseUrl>", "base URL of the Fleet Ship host", `http://localhost:${DEFAULT_PORT}`);

function client() {
  const opts = clientCommand.opts<{ url: string }>();
  return makeClient(normalizeUrl(opts.url));
}

clientCommand
  .command("ls")
  .description("list workspaces")
  .option("--active", "only show active workspaces")
  .option("--inactive", "only show inactive workspaces")
  .action(async (options: { active?: boolean; inactive?: boolean }) => {
    if (options.active && options.inactive) {
      console.error("fleet-cli: --active and --inactive are mutually exclusive");
      process.exit(1);
    }

    const query =
      options.active ? { active: "true" as const } : options.inactive ? { active: "false" as const } : {};

    const result = await client().workspaces.get({ query });
    const rows = unwrap(result) as WorkspaceSummary[];

    if (rows.length === 0) {
      console.log("no workspaces");
      return;
    }

    console.log(formatWorkspaceTable(rows));
  });

clientCommand
  .command("status")
  .description("show detailed status for a workspace")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).get();
    const status = unwrap(result) as WorkspaceStatus;

    console.log(`repo:   ${status.repo}`);
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
  .argument("<repoOrUrl>", "clone URL or repo name")
  .argument("<name>", "workspace name")
  .requiredOption("-b, --branch <branch>", "branch to check out")
  .action(async (repoOrUrl: string, name: string, options: { branch: string }) => {
    const result = await client().workspaces.post({ repo: repoOrUrl, name, branch: options.branch });
    const summary = unwrap(result) as WorkspaceSummary;

    console.log(`created workspace ${summary.repo}/${summary.name} on branch ${summary.branch}`);
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
  .command("rm")
  .description("delete a workspace")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).delete();
    unwrap(result);

    console.log(`removed ${repo}/${name}`);
  });

clientCommand
  .command("serve")
  .description("Serve the client web ui")
  .argument("<bridgeUrl>", "url for the bridge, defaults to localhost:4700")
  .action((bridgeUrl) => {
    startClientServer(bridgeUrl);
  })


const mainCommand = new Command();

mainCommand.addCommand(clientCommand);
mainCommand.addCommand(ship);
mainCommand.addCommand(bridge);

clientCommand.parseAsync(process.argv);
