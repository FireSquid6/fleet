import { server } from "../server";

const dummyAgents = [
  { id: "agent-1", name: "CI Bot", model: "claude-sonnet-4-6", tools: ["bash", "git"], projectId: "proj-1" },
  { id: "agent-2", name: "Test Runner", model: "claude-haiku-4-5-20251001", tools: ["bash"], projectId: "proj-1" },
];

export default function defineAgents() {
  server.defineProcedure("getProjectAgents", {
    resources: ({ inputs }) => [`project/${inputs.projectId}/agents`],
    procedure: ({ inputs }) => dummyAgents.filter((a) => a.projectId === inputs.projectId),
  });

  server.defineProcedure("createAgent", {
    resources: ({ outputs }) => [`project/${outputs.projectId}/agents`, `agent/${outputs.id}`],
    procedure: ({ inputs }) => {
      const agent = { id: `agent-${Date.now()}`, ...inputs };
      dummyAgents.push(agent);
      return agent;
    },
  });
}
