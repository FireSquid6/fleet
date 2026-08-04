#!/usr/bin/env bun

import { Command } from "commander";
import {
  ARMORY_SECTIONS,
  DEFAULT_PORT,
  type ArmoryFile,
  type ArmoryManifest,
  type ArmorySection,
  type Repo,
  type Role,
  type User,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "fleet-protocol";
import type { ShipInfo, BridgeWorkspaceSummary, ShipArmoryState } from "fleet-bridge/types";
import {
  normalizeUrl,
  promptSecret,
  unwrap,
  type EdenResult,
  type FleetBridgeClient,
} from "fleet-cli-kit";
import { makeClient, SHIP_TOKEN_ENV_VAR } from "./client";
import { BridgeSession, SessionError } from "./session";
import {
  abbreviateRevision,
  formatArmoryShipTable,
  formatArmoryTable,
  formatFleetWorkspaceTable,
  formatRepoTable,
  formatShipTable,
  formatUserTable,
  formatWorkspaceTable,
} from "./format";
import { ship } from "fleet-ship";
import { bridge } from "fleet-bridge";
import { startClientServer } from "fleet-client";
import { launchCommand } from "./launch-command";
import { attachToWorkspace } from "./attach";


const DEFAULT_BRIDGE_URL = "http://localhost:4800";

const clientCommand = new Command()
  .name("client")
  .description("Client subcommand")
  .option("--url <baseUrl>", "base URL of the Fleet Ship host", `http://localhost:${DEFAULT_PORT}`)
  .option("--bridge-url <url>", "base URL of the Fleet Bridge (fleet-wide commands)", DEFAULT_BRIDGE_URL);

function client() {
  const opts = clientCommand.opts<{ url: string }>();
  return makeClient(normalizeUrl(opts.url), process.env[SHIP_TOKEN_ENV_VAR]);
}

const clientBridgeUrl = (): string => bridgeUrlOf(clientCommand);

let openSession: BridgeSession | undefined;

function sessionFor(url: string): BridgeSession {
  if (openSession?.url !== url) openSession = new BridgeSession(url);
  return openSession;
}

function failSession(error: unknown): never {
  if (!(error instanceof SessionError)) throw error;
  console.error(`fleet: ${error.message}`);
  process.exit(1);
}

async function bridgeCall<R extends EdenResult<unknown>>(
  url: string,
  fn: (client: FleetBridgeClient) => Promise<R>,
): Promise<R> {
  try {
    return await sessionFor(url).call(fn);
  } catch (error) {
    failSession(error);
  }
}

function bridgeUrlOption(command: Command): Command {
  return command.option("--bridge-url <url>", "base URL of the Fleet Bridge", DEFAULT_BRIDGE_URL);
}

function bridgeUrlOf(command: Command): string {
  return normalizeUrl(command.opts<{ bridgeUrl: string }>().bridgeUrl);
}

async function promptNewPassword(username: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error("fleet: a password has to be typed at a terminal, and stdin is not one");
    process.exit(1);
  }

  let chosen = await promptSecret(`password for ${username}: `);
  while (chosen !== (await promptSecret("confirm password: "))) {
    console.error("passwords did not match, try again");
    chosen = await promptSecret(`password for ${username}: `);
  }
  return chosen;
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
      const result = await bridgeCall(clientBridgeUrl(), (api) => api.workspaces.get({ query }));
      const rows = unwrap(result, "fleet") as BridgeWorkspaceSummary[];
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log("no workspaces");
      } else {
        console.log(formatFleetWorkspaceTable(rows));
      }
      return;
    }

    const rows = unwrap(await client().workspaces.get({ query }), "fleet") as WorkspaceSummary[];
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
    const status = unwrap(result, "fleet") as WorkspaceStatus;

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
  .requiredOption("-b, --branch <branch>", "branch to check out (created if it does not exist)")
  .action(async (repoName: string, name: string, options: { url: string; branch: string }) => {
    const result = await client().workspaces.post({
      url: options.url,
      repoName,
      name,
      branch: options.branch,
    });
    const summary = unwrap(result, "fleet") as WorkspaceSummary;

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
    unwrap(result, "fleet");

    console.log(`switched ${repo}/${name} to branch ${newBranch}`);
  });

clientCommand
  .command("activate")
  .description("activate a workspace (start its tmux session)")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).activate.post();
    unwrap(result, "fleet");

    console.log(`activated ${repo}/${name}`);
  });

clientCommand
  .command("deactivate")
  .description("deactivate a workspace (stop its tmux session)")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).deactivate.post();
    unwrap(result, "fleet");

    console.log(`deactivated ${repo}/${name}`);
  });

clientCommand
  .command("attach")
  .description("attach to a workspace's terminal (Ctrl-] to detach)")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const { url } = clientCommand.opts<{ url: string }>();
    const code = await attachToWorkspace(normalizeUrl(url), repo, name, process.env[SHIP_TOKEN_ENV_VAR]);
    process.exit(code);
  });

clientCommand
  .command("rm")
  .description("delete a workspace")
  .argument("<repo>", "repo name")
  .argument("<name>", "workspace name")
  .action(async (repo: string, name: string) => {
    const result = await client().workspaces({ repo })({ name }).delete();
    unwrap(result, "fleet");

    console.log(`removed ${repo}/${name}`);
  });

const shipsCommand = new Command().name("ships").description("manage the fleet's ships (via the bridge)");

shipsCommand
  .command("ls")
  .description("list the ships registered with the bridge")
  .option("--json", "output as JSON")
  .action(async (options: { json?: boolean }) => {
    const result = await bridgeCall(clientBridgeUrl(), (api) => api.ships.get());
    const rows = unwrap(result, "fleet") as ShipInfo[];
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
    const result = await bridgeCall(clientBridgeUrl(), (api) => api.ships.post({ url: normalizeUrl(url) }));
    const created = unwrap(result, "fleet") as ShipInfo;
    console.log(`registered ship ${created.name} (${created.url})`);
  });

shipsCommand
  .command("rm")
  .description("deregister a ship")
  .argument("<name>", "ship name")
  .action(async (name: string) => {
    unwrap(await bridgeCall(clientBridgeUrl(), (api) => api.ships({ name }).delete()), "fleet");
    console.log(`removed ship ${name}`);
  });

clientCommand.addCommand(shipsCommand);

const reposCommand = new Command().name("repos").description("manage the fleet's repos (via the bridge)");

reposCommand
  .command("ls")
  .description("list the repos registered with the bridge")
  .option("--json", "output as JSON")
  .action(async (options: { json?: boolean }) => {
    const result = await bridgeCall(clientBridgeUrl(), (api) => api.repos.get());
    const rows = unwrap(result, "fleet") as Repo[];
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
    const result = await bridgeCall(clientBridgeUrl(), (api) =>
      api.repos.post({ name, url, provider: options.provider }),
    );
    const repo = unwrap(result, "fleet") as Repo;
    console.log(`registered repo ${repo.name} (${repo.url})`);
  });

reposCommand
  .command("rm")
  .description("deregister a repo")
  .argument("<name>", "repo name")
  .action(async (name: string) => {
    unwrap(await bridgeCall(clientBridgeUrl(), (api) => api.repos({ name }).delete()), "fleet");
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

    const manifest = unwrap(
      await bridgeCall(clientBridgeUrl(), (api) => api.armory.get()),
      "fleet",
    ) as ArmoryManifest;
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
    const result = await bridgeCall(clientBridgeUrl(), (api) => api.armory.file.get({ query: { path } }));
    const file = unwrap(result, "fleet") as ArmoryFile;

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
    const result = await bridgeCall(clientBridgeUrl(), (api) => api.armory.ships.get());
    const rows = unwrap(result, "fleet") as ShipArmoryState[];
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("no ships");
      return;
    }

    const manifest = unwrap(
      await bridgeCall(clientBridgeUrl(), (api) => api.armory.get()),
      "fleet",
    ) as ArmoryManifest;
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


const loginCommand = bridgeUrlOption(
  new Command().name("login").description("log in to a Fleet Bridge and store the session"),
)
  .option("-u, --username <username>", "username to log in as (prompted for otherwise)")
  .action(async (options: { username?: string }, command: Command) => {
    const url = bridgeUrlOf(command);
    try {
      const session = await sessionFor(url).logIn(options.username);
      console.log(`logged in to ${url} as ${session.username}`);
    } catch (error) {
      failSession(error);
    }
  });

const logoutCommand = bridgeUrlOption(
  new Command().name("logout").description("revoke the stored session and delete it"),
).action(async (_options: unknown, command: Command) => {
  const url = bridgeUrlOf(command);
  await sessionFor(url).logOut();
  console.log(`logged out of ${url}`);
});

const whoamiCommand = bridgeUrlOption(
  new Command().name("whoami").description("show who the stored session belongs to"),
).action(async (_options: unknown, command: Command) => {
  const url = bridgeUrlOf(command);
  try {
    const me = await sessionFor(url).currentUser();
    console.log(me ? `${me.username} (${me.role}) on ${url}` : `not logged in to ${url}`);
  } catch (error) {
    failSession(error);
  }
});

const usersCommand = bridgeUrlOption(
  new Command().name("users").description("manage the bridge's users (admin only)"),
);

const usersUrl = (): string => bridgeUrlOf(usersCommand);

usersCommand
  .command("ls")
  .description("list the bridge's users")
  .option("--json", "output as JSON")
  .action(async (options: { json?: boolean }) => {
    const result = await bridgeCall(usersUrl(), (api) => api.users.get());
    const rows = unwrap(result, "fleet") as User[];
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log("no users");
    } else {
      console.log(formatUserTable(rows));
    }
  });

usersCommand
  .command("add")
  .description("create a user (the password is prompted for, never an argument)")
  .argument("<username>", "username")
  .argument("<email>", "email address")
  .option("--role <role>", "admin or member", "member")
  .action(async (username: string, email: string, options: { role: string }) => {
    const role = parseRole(options.role);
    const password = await promptNewPassword(username);
    const result = await bridgeCall(usersUrl(), (api) =>
      api.users.post({ username, email, password, role }),
    );
    const created = unwrap(result, "fleet") as User;
    console.log(`created user ${created.username} (${created.role})`);
  });

usersCommand
  .command("rm")
  .description("delete a user")
  .argument("<username>", "username")
  .action(async (username: string) => {
    unwrap(await bridgeCall(usersUrl(), (api) => api.users({ name: username }).delete()), "fleet");
    console.log(`removed user ${username}`);
  });

usersCommand
  .command("passwd")
  .description("set a user's password, which revokes their sessions")
  .argument("<username>", "username")
  .action(async (username: string) => {
    const password = await promptNewPassword(username);
    const result = await bridgeCall(usersUrl(), (api) =>
      api.users({ name: username }).password.post({ password }),
    );
    unwrap(result, "fleet");
    console.log(`changed the password for ${username}`);
  });

usersCommand
  .command("role")
  .description("set a user's role")
  .argument("<username>", "username")
  .argument("<role>", "admin or member")
  .action(async (username: string, role: string) => {
    const wanted = parseRole(role);
    const result = await bridgeCall(usersUrl(), (api) =>
      api.users({ name: username }).role.post({ role: wanted }),
    );
    const updated = unwrap(result, "fleet") as User;
    console.log(`${updated.username} is now ${updated.role}`);
  });

function parseRole(role: string): Role {
  if (role !== "admin" && role !== "member") {
    console.error(`fleet: unknown role "${role}"; expected admin or member`);
    process.exit(1);
  }
  return role;
}

const mainCommand = new Command().name("fleet");

mainCommand.addCommand(clientCommand);
mainCommand.addCommand(ship);
mainCommand.addCommand(bridge);
mainCommand.addCommand(launchCommand);
mainCommand.addCommand(loginCommand);
mainCommand.addCommand(logoutCommand);
mainCommand.addCommand(whoamiCommand);
mainCommand.addCommand(usersCommand);

mainCommand.parseAsync(process.argv);
