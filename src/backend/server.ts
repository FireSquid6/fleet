import { SidekickIntegratedCovenantServer } from "@covenant-rpc/sidekick-bun-adapter";
import { covenant } from "../covenant";
import { AutosmithStore } from "../store";
import { AgentManager } from "./agent-manager";

export async function createServer(storeDirectory: string) {
  const store = new AutosmithStore(storeDirectory);
  const agents = new AgentManager(store);
  await store.initialize();

  const server = new SidekickIntegratedCovenantServer(covenant, {
    contextGenerator: () => null,
    derivation: () => null,
    logLevel: "info",
  });

  // ── Projects ───────────────────────────────────────────────────────────────

  server.defineProcedure("listProjects", {
    resources: () => ["projects"],
    procedure: async () => {
      const names = await store.listProjects();
      return Promise.all(
        names.map(async name => ({ name, ...(await store.getProject(name)) })),
      );
    },
  });

  server.defineProcedure("getProject", {
    resources: ({ inputs }) => [`project/${inputs.name}`],
    procedure: async ({ inputs }) => ({
      name: inputs.name,
      ...(await store.getProject(inputs.name)),
    }),
  });

  server.defineProcedure("createProject", {
    resources: () => ["projects"],
    procedure: async ({ inputs }) => {
      const { name, ...data } = inputs;
      await store.createProject(name, data);
      return null;
    },
  });

  server.defineProcedure("updateProject", {
    resources: ({ inputs }) => ["projects", `project/${inputs.name}`],
    procedure: async ({ inputs }) => {
      const { name, ...data } = inputs;
      await store.updateProject(name, data);
      return null;
    },
  });

  server.defineProcedure("deleteProject", {
    resources: () => ["projects"],
    procedure: async ({ inputs }) => {
      await store.deleteProject(inputs.name);
      return null;
    },
  });

  // ── Agents ─────────────────────────────────────────────────────────────────

  server.defineProcedure("listAgents", {
    resources: ({ inputs }) => [`project/${inputs.projectName}/agents`],
    procedure: async ({ inputs }) => {
      const names = await store.listAgents(inputs.projectName);
      return Promise.all(
        names.map(async agentName => ({
          projectName: inputs.projectName,
          ...(await store.getAgent(inputs.projectName, agentName)),
        })),
      );
    },
  });

  server.defineProcedure("getAgent", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}`],
    procedure: async ({ inputs }) => ({
      projectName: inputs.projectName,
      ...(await store.getAgent(inputs.projectName, inputs.agentName)),
    }),
  });

  server.defineProcedure("createAgent", {
    resources: ({ inputs }) => [`project/${inputs.projectName}/agents`],
    procedure: async ({ inputs }) => {
      const { projectName, ...data } = inputs;
      await store.createAgent(projectName, data.name, data);
      return null;
    },
  });

  server.defineProcedure("updateAgent", {
    resources: ({ inputs }) => [
      `project/${inputs.projectName}/agents`,
      `agent/${inputs.projectName}/${inputs.name}`,
    ],
    procedure: async ({ inputs }) => {
      const { projectName, name, ...data } = inputs;
      await store.updateAgent(projectName, name, data);
      return null;
    },
  });

  server.defineProcedure("deleteAgent", {
    resources: ({ inputs }) => [`project/${inputs.projectName}/agents`],
    procedure: async ({ inputs }) => {
      await store.deleteAgent(inputs.projectName, inputs.agentName);
      return null;
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  server.defineProcedure("startAgent", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/status`],
    procedure: async ({ inputs }) => {
      await agents.start(inputs.projectName, inputs.agentName);
      return null;
    },
  });

  server.defineProcedure("stopAgent", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/status`],
    procedure: async ({ inputs }) => {
      await agents.stop(inputs.projectName, inputs.agentName);
      return null;
    },
  });

  server.defineProcedure("isAgentRunning", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/status`],
    procedure: ({ inputs }) => agents.isRunning(inputs.projectName, inputs.agentName),
  });

  server.defineProcedure("getAgentHistory", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/history`],
    procedure: ({ inputs, error }) => {
      const agent = agents.get(inputs.projectName, inputs.agentName);
      if (!agent) error("Agent is not running", 404);
      return agent!.getHistory();
    },
  });

  // ── Agent session channel ──────────────────────────────────────────────────

  server.defineChannel("agentSession", {
    onConnect: async ({ params, reject }) => {
      const projectName = params.projectName ?? "";
      const agentName = params.agentName ?? "";
      if (!agents.isRunning(projectName, agentName)) {
        reject("Agent is not running", "client");
      }
      return { projectName, agentName };
    },

    onMessage: async ({ inputs, params, error }) => {
      const agent = agents.get(params.projectName ?? "", params.agentName ?? "");
      if (!agent) return error("Agent is not running", "client");

      if (inputs.type === "compact") {
        await agent.compact();
        return;
      }

      if (inputs.type === "clear") {
        agent.clear();
        return;
      }

      // inputs.type === "input"
      for await (const event of agent.send(inputs.text)) {
        if (event.type === "error") {
          await server.sendMessage("agentSession", params, {
            type: "error",
            error: String(event.error),
          });
        } else {
          await server.sendMessage("agentSession", params, event);
        }
      }

      await server.sendMessage("agentSession", params, { type: "done" });
    },
  });

  server.assertAllDefined();

  return { server, store, agents };
}
