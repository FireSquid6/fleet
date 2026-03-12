import type { AppServer } from "../server-types";
import type { AgentManager } from "../agent-manager";
import type { AutosmithStore } from "../../store";

export function registerLifecycleProcedures(server: AppServer, agents: AgentManager, store: AutosmithStore) {
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

  server.defineProcedure("getAgentStatus", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/status`],
    procedure: ({ inputs }) => agents.getStatus(inputs.projectName, inputs.agentName),
  });

  server.defineProcedure("listRunningAgents", {
    resources: () => ["agents/running"],
    procedure: () => agents.listRunning(),
  });

  server.defineProcedure("getAgentHistory", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/history`],
    procedure: async ({ inputs }) => {
      const agent = agents.get(inputs.projectName, inputs.agentName);
      if (agent) return agent.getHistory();
      const session = await store.readAgentSession(inputs.projectName, inputs.agentName);
      return session?.history ?? [];
    },
  });
}
