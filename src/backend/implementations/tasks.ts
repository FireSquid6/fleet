import { server } from "../server";

const dummyTasks = [
  { id: "task-1", title: "Set up CI pipeline", status: "done" as const, projectId: "proj-1", assignedAgentId: "agent-1" },
  { id: "task-2", title: "Write integration tests", status: "in-progress" as const, projectId: "proj-1", assignedAgentId: undefined },
  { id: "task-3", title: "Add rate limiting", status: "todo" as const, projectId: "proj-1", assignedAgentId: undefined },
  { id: "task-4", title: "Deploy to staging", status: "todo" as const, projectId: "proj-2", assignedAgentId: undefined },
];

export default function defineTasks() {
  server.defineProcedure("getProjectTasks", {
    resources: ({ inputs }) => [`project/${inputs.projectId}/tasks`],
    procedure: ({ inputs }) => {
      return dummyTasks
        .filter((t) => t.projectId === inputs.projectId)
        .map(({ projectId: _, ...task }) => task);
    },
  });
}
