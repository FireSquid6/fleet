import type { AppServer } from "../server-types";
import type { AutosmithStore } from "../../store";

export function registerContentProcedures(server: AppServer, store: AutosmithStore) {
  // ── Token reads ────────────────────────────────────────────────────────────

  server.defineProcedure("getRootTokens", {
    resources: () => ["tokens/root"],
    procedure: () => store.tokens.readAll(),
  });

  server.defineProcedure("getProjectTokens", {
    resources: ({ inputs }) => [`tokens/project/${inputs.projectName}`],
    procedure: ({ inputs }) => store.projectTokens(inputs.projectName).readAll(),
  });

  server.defineProcedure("getAgentTokens", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/tokens`],
    procedure: ({ inputs }) =>
      store.getLayeredAgentTokens(inputs.projectName, inputs.agentName),
  });

  // ── Token writes (root) ────────────────────────────────────────────────────

  server.defineProcedure("setRootToken", {
    resources: () => ["tokens/root"],
    procedure: async ({ inputs }) => {
      await store.tokens.set(inputs.name, inputs.value);
      return null;
    },
  });

  server.defineProcedure("deleteRootToken", {
    resources: () => ["tokens/root"],
    procedure: async ({ inputs }) => {
      await store.tokens.delete(inputs.name);
      return null;
    },
  });

  // ── Token writes (project) ─────────────────────────────────────────────────

  server.defineProcedure("setProjectToken", {
    resources: ({ inputs }) => [`tokens/project/${inputs.projectName}`],
    procedure: async ({ inputs }) => {
      await store.projectTokens(inputs.projectName).set(inputs.name, inputs.value);
      return null;
    },
  });

  server.defineProcedure("deleteProjectToken", {
    resources: ({ inputs }) => [`tokens/project/${inputs.projectName}`],
    procedure: async ({ inputs }) => {
      await store.projectTokens(inputs.projectName).delete(inputs.name);
      return null;
    },
  });

  // ── Token writes (agent) ───────────────────────────────────────────────────

  server.defineProcedure("setAgentToken", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/tokens`],
    procedure: async ({ inputs }) => {
      await store.agentTokens(inputs.projectName, inputs.agentName).set(inputs.name, inputs.value);
      return null;
    },
  });

  server.defineProcedure("deleteAgentToken", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/tokens`],
    procedure: async ({ inputs }) => {
      await store.agentTokens(inputs.projectName, inputs.agentName).delete(inputs.name);
      return null;
    },
  });

  // ── Instructions — read ────────────────────────────────────────────────────

  server.defineProcedure("getRootInstructions", {
    resources: () => ["instructions/root"],
    procedure: () => store.getRootInstructions(),
  });

  server.defineProcedure("getProjectInstructions", {
    resources: ({ inputs }) => [`project/${inputs.projectName}/instructions`],
    procedure: ({ inputs }) => store.getProjectInstructions(inputs.projectName),
  });

  server.defineProcedure("getAgentInstructions", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/instructions`],
    procedure: ({ inputs }) => store.getAgentInstructions(inputs.projectName, inputs.agentName),
  });

  // ── Instructions — write ───────────────────────────────────────────────────

  server.defineProcedure("setRootInstructions", {
    resources: () => ["instructions/root"],
    procedure: async ({ inputs }) => {
      await store.setRootInstructions(inputs.content);
      return null;
    },
  });

  server.defineProcedure("setProjectInstructions", {
    resources: ({ inputs }) => [`project/${inputs.projectName}/instructions`],
    procedure: async ({ inputs }) => {
      await store.setProjectInstructions(inputs.projectName, inputs.content);
      return null;
    },
  });

  server.defineProcedure("setAgentInstructions", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/instructions`],
    procedure: async ({ inputs }) => {
      await store.setAgentInstructions(inputs.projectName, inputs.agentName, inputs.content);
      return null;
    },
  });

  // ── Skills ─────────────────────────────────────────────────────────────────

  server.defineProcedure("listSkills", {
    resources: () => ["skills"],
    procedure: async () => {
      const names = await store.skills.list();
      return Promise.all(names.map(name => store.skills.get(name)));
    },
  });

  server.defineProcedure("getAgentSkills", {
    resources: ({ inputs }) => [`agent/${inputs.projectName}/${inputs.agentName}/skills`],
    procedure: async ({ inputs }) => {
      const agentConfig = await store.getAgent(inputs.projectName, inputs.agentName);
      return Promise.all(agentConfig.skills.map(name => store.skills.get(name)));
    },
  });
}
