import { useState } from "react";
import { useParams, Link, NavLink, useLocation } from "react-router-dom";
import { covenantClient } from "../client";
import TaskDetail, { type ExtendedTask } from "../components/TaskDetail";

const STATUSES = ["todo", "in-progress", "done"] as const;
const STATUS_LABELS: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "done": "Done",
};

// Mock extra data layered on top of API tasks (frontend-only for now)
const MOCK_EXTRA: Record<string, Partial<ExtendedTask>> = {
  "task-1": {
    description: "Set up GitHub Actions workflows for linting, testing, and deploying to production on merge to main.",
  },
  "task-2": {
    description: "Write comprehensive integration tests covering all API endpoints, including auth flows and error cases.",
    // Ensure in-progress tasks always have an agent
    assignedAgentId: "agent-1",
  },
  "task-3": {
    description: "Implement rate limiting middleware to prevent API abuse and ensure fair resource usage across all clients.",
    assignedAgentId: "agent-2",
    plan: `## Goal
Add rate limiting to the API server to prevent abuse and ensure fair usage.

## Steps

1. **Research & decide algorithm**
   - Evaluate token bucket vs sliding window
   - Token bucket chosen: simpler, fits bursty traffic patterns

2. **Implement middleware** (\`src/backend/middleware/rateLimit.ts\`)
   - 100 req/min for unauthenticated, 1000 req/min for authenticated
   - In-memory store initially; swap to Bun.redis for production

3. **Response headers**
   - Add \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\`
   - Return HTTP 429 with \`Retry-After\` when limit exceeded

4. **Tests**
   - Unit tests for bucket logic
   - Integration tests asserting 429 on breach

5. **Docs update**
   - Update OpenAPI spec with rate limit info
   - Add ops runbook entry for tuning limits`,
  },
};

let nextLocalId = 1;

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const isAgentsTab = location.pathname.endsWith("/agents");

  const { data: project, loading: projectLoading } = covenantClient.useQuery("getProject", { id: projectId! });
  const { data: apiTasks, loading: tasksLoading } = covenantClient.useQuery("getProjectTasks", { projectId: projectId! });
  const { data: agentsData } = covenantClient.useQuery("getProjectAgents", { projectId: projectId! });
  const agents = agentsData ?? [];

  const [localTasks, setLocalTasks] = useState<ExtendedTask[]>([]);
  const [agentAssignments, setAgentAssignments] = useState<Record<string, string>>({});
  const [selectedTask, setSelectedTask] = useState<ExtendedTask | null>(null);
  const [addingToStatus, setAddingToStatus] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");

  // Merge API tasks with mock extended data and local assignment overrides
  const tasks: ExtendedTask[] = [
    ...(apiTasks ?? []).map((t) => ({
      description: "No description provided.",
      ...t,
      ...MOCK_EXTRA[t.id],
      assignedAgentId: agentAssignments[t.id] ?? (MOCK_EXTRA[t.id]?.assignedAgentId ?? t.assignedAgentId),
    })),
    ...localTasks.map((t) => ({
      ...t,
      assignedAgentId: agentAssignments[t.id] ?? t.assignedAgentId,
    })),
  ];

  const handleAssign = (taskId: string, agentId: string) => {
    setAgentAssignments((prev) => ({ ...prev, [taskId]: agentId }));
    setSelectedTask((prev) => prev ? { ...prev, assignedAgentId: agentId } : null);
  };

  const handleAddTask = (status: string) => {
    const title = newTaskTitle.trim();
    if (!title) return;
    const id = `local-${nextLocalId++}`;
    setLocalTasks((prev) => [
      ...prev,
      {
        id,
        title,
        status: status as ExtendedTask["status"],
        description: "No description yet.",
      },
    ]);
    setNewTaskTitle("");
    setAddingToStatus(null);
  };

  if (projectLoading) return <div className="p-8">Loading...</div>;
  if (!project) return <div className="p-8">Project not found</div>;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-1">{project.name}</h1>
      <p className="text-sm text-base-content/60 mb-6">{project.repoUrl}</p>

      <div role="tablist" className="tabs tabs-boxed mb-6 w-fit">
        <Link role="tab" to={`/project/${projectId}`} className={`tab ${!isAgentsTab ? "tab-active" : ""}`}>
          Board
        </Link>
        <Link role="tab" to={`/project/${projectId}/agents`} className={`tab ${isAgentsTab ? "tab-active" : ""}`}>
          Agents
        </Link>
      </div>

      {tasksLoading && <div>Loading tasks...</div>}

      <div className="grid grid-cols-3 gap-4">
        {STATUSES.map((status) => {
          const columnTasks = tasks.filter((t) => t.status === status);
          return (
            <div key={status} className="flex flex-col gap-2">
              <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">
                {STATUS_LABELS[status]}{" "}
                <span className="text-base-content/40 font-normal">({columnTasks.length})</span>
              </h2>

              {columnTasks.map((task) => {
                const agent = agents.find((a) => a.id === task.assignedAgentId);
                return (
                  <button
                    key={task.id}
                    className="card bg-base-100 shadow-sm text-left w-full hover:bg-base-200 transition-colors cursor-pointer"
                    onClick={() => setSelectedTask(task)}
                  >
                    <div className="card-body p-3 gap-1">
                      <p className="text-sm font-medium">{task.title}</p>
                      {agent ? (
                        <NavLink
                          to={`/project/${projectId}/agents/${agent.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="badge badge-accent badge-sm self-start hover:badge-warning transition-colors"
                        >
                          {agent.name}
                        </NavLink>
                      ) : task.status === "todo" ? (
                        <span className="text-xs text-base-content/30 italic">Unassigned</span>
                      ) : null}
                    </div>
                  </button>
                );
              })}

              {/* Only show add button for todo column */}
              {status === "todo" && (
                addingToStatus === status ? (
                  <form
                    className="flex flex-col gap-1"
                    onSubmit={(e) => { e.preventDefault(); handleAddTask(status); }}
                  >
                    <input
                      autoFocus
                      className="input input-bordered input-sm w-full"
                      placeholder="Task title..."
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                    />
                    <div className="flex gap-1">
                      <button type="submit" className="btn btn-primary btn-sm flex-1">Add</button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setAddingToStatus(null); setNewTaskTitle(""); }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm justify-start text-base-content/40 hover:text-base-content"
                    onClick={() => setAddingToStatus(status)}
                  >
                    + Add task
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>

      {selectedTask && (
        <TaskDetail
          task={{
            ...selectedTask,
            assignedAgentId: agentAssignments[selectedTask.id] ?? selectedTask.assignedAgentId,
          }}
          agents={agents}
          onClose={() => setSelectedTask(null)}
          onAssign={handleAssign}
        />
      )}
    </div>
  );
}
