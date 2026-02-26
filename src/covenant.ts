import { declareCovenant, query, mutation } from "@covenant-rpc/core";
import { z } from "zod";

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  dockerImage: z.string(),
  subdirectory: z.string().optional(),
});

const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["todo", "in-progress", "done"]),
  assignedAgentId: z.string().optional(),
});

const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  projectId: z.string(),
});

export const covenant = declareCovenant({
  procedures: {
    getProjects: query({
      input: z.null(),
      output: z.array(ProjectSchema),
    }),
    getProject: query({
      input: z.object({ id: z.string() }),
      output: ProjectSchema,
    }),
    createProject: mutation({
      input: z.object({
        repoUrl: z.string(),
        dockerImage: z.string(),
        subdirectory: z.string().optional(),
      }),
      output: ProjectSchema,
    }),
    getProjectTasks: query({
      input: z.object({ projectId: z.string() }),
      output: z.array(TaskSchema),
    }),
    getProjectAgents: query({
      input: z.object({ projectId: z.string() }),
      output: z.array(AgentSchema),
    }),
    createAgent: mutation({
      input: z.object({
        projectId: z.string(),
        name: z.string(),
        model: z.string(),
        tools: z.array(z.string()),
      }),
      output: AgentSchema,
    }),
  },
  channels: {},
});
