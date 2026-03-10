import { declareCovenant, query, mutation, channel } from "@covenant-rpc/core";
import { z } from "zod";

// These are the canonical schemas — store/index.ts imports from here.

export const projectSchema = z.object({
  provider: z.string(),
  filesystemType: z.string(),
  owner: z.string(),
  repository: z.string(),
  // name of the entry in tokens.yaml to use as the git provider token
  tokenName: z.string(),
});

export const agentSchema = z.object({
  name: z.string(),
  provider: z.string(),
  dockerImage: z.string().default("fleet/agent:latest"),
  // path where the workspace is mounted inside the container
  filesystemMountPoint: z.string().default("/workspace"),
});

// API-layer schemas extend the base schemas with identifier fields
const ProjectSchema = projectSchema.extend({ name: z.string() });
const AgentSchema = agentSchema.extend({ projectName: z.string() });

const AgentIdSchema = z.object({ projectName: z.string(), agentName: z.string() });

export const covenant = declareCovenant({
  procedures: {
    // Projects
    listProjects: query({ input: z.null(), output: z.array(ProjectSchema) }),
    getProject: query({ input: z.object({ name: z.string() }), output: ProjectSchema }),
    createProject: mutation({ input: ProjectSchema, output: z.null() }),
    updateProject: mutation({
      input: projectSchema.partial().extend({ name: z.string() }),
      output: z.null(),
    }),
    deleteProject: mutation({ input: z.object({ name: z.string() }), output: z.null() }),

    // Agents
    listAgents: query({ input: z.object({ projectName: z.string() }), output: z.array(AgentSchema) }),
    getAgent: query({ input: AgentIdSchema, output: AgentSchema }),
    createAgent: mutation({ input: AgentSchema, output: z.null() }),
    updateAgent: mutation({
      input: agentSchema.partial().extend({ name: z.string(), projectName: z.string() }),
      output: z.null(),
    }),
    deleteAgent: mutation({ input: AgentIdSchema, output: z.null() }),

    // Lifecycle
    startAgent: mutation({ input: AgentIdSchema, output: z.null() }),
    stopAgent: mutation({ input: AgentIdSchema, output: z.null() }),
    isAgentRunning: query({ input: AgentIdSchema, output: z.boolean() }),
  },

  channels: {
    agentSession: channel({
      params: ["projectName", "agentName"],
      connectionRequest: z.object({}),
      connectionContext: z.object({
        projectName: z.string(),
        agentName: z.string(),
      }),
      clientMessage: z.union([
        z.object({ type: z.literal("input"), text: z.string() }),
        z.object({ type: z.literal("compact") }),
        z.object({ type: z.literal("clear") }),
      ]),
      serverMessage: z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("tool-call"), toolName: z.string(), input: z.any() }),
        z.object({ type: z.literal("tool-result"), toolName: z.string(), result: z.any() }),
        z.object({ type: z.literal("error"), error: z.string() }),
        z.object({ type: z.literal("done") }),
      ]),
    }),
  },
});
