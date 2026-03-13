import { declareCovenant, query, mutation, channel } from "@covenant-rpc/core";
import { z } from "zod";


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
  dockerImage: z.string().default("autosmith/agent:latest"),
  // path where the workspace is mounted inside the container
  filesystemMountPoint: z.string().default("/workspace"),
  // names of skills from the autosmith skills/ directory to give this agent
  skills: z.array(z.string()).default([]),
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

    // User
    getUser: query({
      input: z.null(),
      output: z.object({ name: z.string(), email: z.string(), phone: z.string() }),
    }),
    updateUser: mutation({
      input: z.object({ name: z.string().optional(), email: z.string().optional(), phone: z.string().optional() }),
      output: z.null(),
    }),
    openAgentWorkspace: mutation({
      input: z.object({
        project: z.string(),
        agent: z.string(),
      }),
      output: z.enum(["opened", "failed"]),
    }),

    // Lifecycle
    startAgent: mutation({ input: AgentIdSchema, output: z.null() }),
    stopAgent: mutation({ input: AgentIdSchema, output: z.null() }),
    isAgentRunning: query({ input: AgentIdSchema, output: z.boolean() }),
    getAgentStatus: query({
      input: AgentIdSchema,
      output: z.enum(["stopped", "idle", "running"]),
    }),
    listRunningAgents: query({
      input: z.null(),
      output: z.array(AgentIdSchema),
    }),

    // Tokens — read
    getRootTokens: query({ input: z.null(), output: z.record(z.string(), z.string()) }),
    getProjectTokens: query({
      input: z.object({ projectName: z.string() }),
      output: z.record(z.string(), z.string()),
    }),

    // Tokens — write (root)
    setRootToken: mutation({ input: z.object({ name: z.string(), value: z.string() }), output: z.null() }),
    deleteRootToken: mutation({ input: z.object({ name: z.string() }), output: z.null() }),

    // Tokens — write (project)
    setProjectToken: mutation({
      input: z.object({ projectName: z.string(), name: z.string(), value: z.string() }),
      output: z.null(),
    }),
    deleteProjectToken: mutation({
      input: z.object({ projectName: z.string(), name: z.string() }),
      output: z.null(),
    }),

    // Tokens — write (agent)
    setAgentToken: mutation({
      input: AgentIdSchema.extend({ name: z.string(), value: z.string() }),
      output: z.null(),
    }),
    deleteAgentToken: mutation({
      input: AgentIdSchema.extend({ name: z.string() }),
      output: z.null(),
    }),

    // Instructions — read
    getRootInstructions: query({ input: z.null(), output: z.string() }),
    getProjectInstructions: query({
      input: z.object({ projectName: z.string() }),
      output: z.string(),
    }),
    getAgentInstructions: query({
      input: AgentIdSchema,
      output: z.string(),
    }),

    // Instructions — write
    setRootInstructions: mutation({ input: z.object({ content: z.string() }), output: z.null() }),
    setProjectInstructions: mutation({
      input: z.object({ projectName: z.string(), content: z.string() }),
      output: z.null(),
    }),
    setAgentInstructions: mutation({
      input: AgentIdSchema.extend({ content: z.string() }),
      output: z.null(),
    }),
    getAgentTokens: query({
      input: AgentIdSchema,
      output: z.object({
        root: z.record(z.string(), z.string()),
        project: z.record(z.string(), z.string()),
        agent: z.record(z.string(), z.string()),
      }),
    }),
    listSkills: query({
      input: z.null(),
      output: z.array(z.object({
        name: z.string(),
        title: z.string(),
        description: z.string(),
        content: z.string(),
      })),
    }),
    getAgentSkills: query({
      input: AgentIdSchema,
      output: z.array(z.object({
        name: z.string(),
        title: z.string(),
        description: z.string(),
        content: z.string(),
      })),
    }),

    // History
    getAgentHistory: query({
      input: AgentIdSchema,
      output: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        parts: z.array(z.union([
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({ type: z.literal("tool"), toolName: z.string(), input: z.any(), result: z.any().optional() }),
          z.object({ type: z.literal("error"), error: z.string() }),
        ])),
      })),
    }),
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
