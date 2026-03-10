import { Command } from "@commander-js/extra-typings";
import { CovenantClient } from "@covenant-rpc/client";
import { httpClientToServer, httpClientToSidekick } from "@covenant-rpc/client/interfaces/http";
import { covenant } from "../covenant";

function makeClient(url: string) {
  return new CovenantClient(covenant, {
    serverConnection: httpClientToServer(`${url}/api/covenant`, {}),
    sidekickConnection: httpClientToSidekick(`${url}/socket`),
  });
}

function getUrl(cmd: { optsWithGlobals: () => unknown }): string {
  return (cmd.optsWithGlobals() as { url: string }).url;
}

function unwrap<T>(result: {
  success: boolean;
  data?: T | null;
  error?: { message: string; code: number } | null;
}): T {
  if (!result.success) {
    console.error(`Error: ${result.error?.message ?? "unknown"} (${result.error?.code})`);
    process.exit(1);
  }
  return result.data as T;
}

function printRecord(record: Record<string, unknown>) {
  for (const [key, value] of Object.entries(record)) {
    console.log(`${key}: ${value}`);
  }
}

// --- Project subcommands ---

const projectListCommand = new Command()
  .name("list")
  .description("List all projects")
  .action(async function (this: Command) {
    const client = makeClient(getUrl(this));
    const result = await client.query("listProjects", null);
    const projects = unwrap(result);
    if (projects.length === 0) {
      console.log("No projects found.");
      return;
    }
    console.table(projects);
  });

const projectGetCommand = new Command()
  .name("get")
  .description("Get a project by name")
  .argument("<name>", "project name")
  .action(async (name: string, _opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const result = await client.query("getProject", { name });
    const project = unwrap(result);
    printRecord(project as Record<string, unknown>);
  });

const projectCreateCommand = new Command()
  .name("create")
  .description("Create a new project")
  .requiredOption("--name <name>", "project name")
  .requiredOption("--provider <provider>", "git provider (e.g. github)")
  .requiredOption("--filesystem-type <filesystemType>", "filesystem type (e.g. local-docker)")
  .requiredOption("--owner <owner>", "repository owner")
  .requiredOption("--repository <repository>", "repository name")
  .requiredOption("--token-name <tokenName>", "name of the token in tokens.yaml")
  .action(async function (this: Command, opts) {
    const client = makeClient(getUrl(this));
    const result = await client.mutate("createProject", opts);
    unwrap(result);
    console.log(`Project "${opts.name}" created.`);
  });

const projectDeleteCommand = new Command()
  .name("delete")
  .description("Delete a project by name")
  .argument("<name>", "project name")
  .action(async (name: string, _opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const result = await client.mutate("deleteProject", { name });
    unwrap(result);
    console.log(`Project "${name}" deleted.`);
  });

const projectCommand = new Command()
  .name("project")
  .description("Manage projects")
  .addCommand(projectListCommand)
  .addCommand(projectGetCommand)
  .addCommand(projectCreateCommand)
  .addCommand(projectDeleteCommand);

// --- Agent subcommands ---

const agentListCommand = new Command()
  .name("list")
  .description("List agents for a project")
  .requiredOption("--project <projectName>", "project name")
  .action(async function (this: Command, opts) {
    const client = makeClient(getUrl(this));
    const result = await client.query("listAgents", { projectName: opts.project });
    const agents = unwrap(result);
    if (agents.length === 0) {
      console.log("No agents found.");
      return;
    }
    console.table(agents);
  });

const agentGetCommand = new Command()
  .name("get")
  .description("Get an agent by name")
  .argument("<agentName>", "agent name")
  .requiredOption("--project <projectName>", "project name")
  .action(async (agentName: string, opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const result = await client.query("getAgent", {
      projectName: opts.project,
      agentName,
    });
    const agent = unwrap(result);
    printRecord(agent as Record<string, unknown>);
  });

const agentCreateCommand = new Command()
  .name("create")
  .description("Create a new agent")
  .requiredOption("--project <projectName>", "project name")
  .requiredOption("--name <name>", "agent name")
  .requiredOption("--provider <provider>", "model provider")
  .option("--docker-image <dockerImage>", "docker image", "fleet/agent:latest")
  .option(
    "--filesystem-mount-point <filesystemMountPoint>",
    "path where workspace is mounted",
    "/workspace"
  )
  .action(async function (this: Command, opts) {
    const client = makeClient(getUrl(this));
    const result = await client.mutate("createAgent", {
      projectName: opts.project,
      name: opts.name,
      provider: opts.provider,
      dockerImage: opts.dockerImage,
      filesystemMountPoint: opts.filesystemMountPoint,
    });
    unwrap(result);
    console.log(`Agent "${opts.name}" created.`);
  });

const agentDeleteCommand = new Command()
  .name("delete")
  .description("Delete an agent")
  .argument("<agentName>", "agent name")
  .requiredOption("--project <projectName>", "project name")
  .action(async (agentName: string, opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const result = await client.mutate("deleteAgent", {
      projectName: opts.project,
      agentName,
    });
    unwrap(result);
    console.log(`Agent "${agentName}" deleted.`);
  });

const agentCommand = new Command()
  .name("agent")
  .description("Manage agents")
  .addCommand(agentListCommand)
  .addCommand(agentGetCommand)
  .addCommand(agentCreateCommand)
  .addCommand(agentDeleteCommand);

// --- Lifecycle commands ---

const startCommand = new Command()
  .name("start")
  .description("Start an agent")
  .argument("<agentName>", "agent name")
  .requiredOption("--project <projectName>", "project name")
  .action(async (agentName: string, opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const result = await client.mutate("startAgent", {
      projectName: opts.project,
      agentName,
    });
    unwrap(result);
    console.log(`Agent "${agentName}" started.`);
  });

const stopCommand = new Command()
  .name("stop")
  .description("Stop an agent")
  .argument("<agentName>", "agent name")
  .requiredOption("--project <projectName>", "project name")
  .action(async (agentName: string, opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const result = await client.mutate("stopAgent", {
      projectName: opts.project,
      agentName,
    });
    unwrap(result);
    console.log(`Agent "${agentName}" stopped.`);
  });

const statusCommand = new Command()
  .name("status")
  .description("Check if an agent is running")
  .argument("<agentName>", "agent name")
  .requiredOption("--project <projectName>", "project name")
  .action(async (agentName: string, opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const result = await client.query("isAgentRunning", {
      projectName: opts.project,
      agentName,
    });
    const running = unwrap(result);
    console.log(`Agent "${agentName}" is ${running ? "running" : "stopped"}.`);
  });

// --- Session REPL ---

const sessionCommand = new Command()
  .name("session")
  .description("Connect to an agent session interactively")
  .argument("<agentName>", "agent name")
  .requiredOption("--project <projectName>", "project name")
  .action(async (agentName: string, opts, cmd) => {
    const client = makeClient(getUrl(cmd));
    const params = { projectName: opts.project, agentName };

    const connectResult = await client.connect("agentSession", params, {});
    if (!connectResult.success) {
      console.error(`Error: ${connectResult.error.message} (${connectResult.error.code})`);
      process.exit(1);
    }
    const token = connectResult.token;

    await client.subscribe("agentSession", params, token, (msg) => {
      if (msg.type === "text") {
        process.stdout.write(msg.text);
      } else if (msg.type === "tool-call") {
        process.stdout.write(`\n[tool: ${msg.toolName}] ${JSON.stringify(msg.input)}\n`);
      } else if (msg.type === "tool-result") {
        process.stdout.write(`[result: ${msg.toolName}] ${JSON.stringify(msg.result)}\n`);
      } else if (msg.type === "error") {
        process.stdout.write(`[error] ${msg.error}\n`);
      } else if (msg.type === "done") {
        process.stdout.write("\n> ");
      }
    });

    process.stdout.write("> ");
    process.stdin.setEncoding("utf8");

    for await (const chunk of process.stdin) {
      const lines = (chunk as string).split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "!compact") {
          await client.send("agentSession", params, token, { type: "compact" });
        } else if (trimmed === "!clear") {
          await client.send("agentSession", params, token, { type: "clear" });
        } else {
          await client.send("agentSession", params, token, { type: "input", text: trimmed });
        }
      }
    }
  });

// --- Root client command ---

export const clientCommand = new Command()
  .name("client")
  .description("Interact with a Fleet server from the CLI")
  .option("--url <url>", "Fleet server URL", "http://localhost:4456")
  .addCommand(projectCommand)
  .addCommand(agentCommand)
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(statusCommand)
  .addCommand(sessionCommand);
