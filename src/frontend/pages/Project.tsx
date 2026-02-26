import { useParams, Link, useLocation } from "react-router-dom";
import { covenantClient } from "../client";

const STATUSES = ["todo", "in-progress", "done"] as const;
const STATUS_LABELS: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "done": "Done",
};

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const isAgentsTab = location.pathname.endsWith("/agents");

  const { data: project, loading: projectLoading } = covenantClient.useQuery("getProject", { id: projectId! });
  const { data: tasks, loading: tasksLoading } = covenantClient.useQuery("getProjectTasks", { projectId: projectId! });

  if (projectLoading) return <div className="p-8">Loading...</div>;
  if (!project) return <div className="p-8">Project not found</div>;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-1">{project.name}</h1>
      <p className="text-sm text-base-content/60 mb-6">{project.repoUrl}</p>

      <div role="tablist" className="tabs tabs-boxed mb-6 w-fit">
        <Link
          role="tab"
          to={`/project/${projectId}`}
          className={`tab ${!isAgentsTab ? "tab-active" : ""}`}
        >
          Board
        </Link>
        <Link
          role="tab"
          to={`/project/${projectId}/agents`}
          className={`tab ${isAgentsTab ? "tab-active" : ""}`}
        >
          Agents
        </Link>
      </div>

      {tasksLoading && <div>Loading tasks...</div>}

      <div className="grid grid-cols-3 gap-4">
        {STATUSES.map((status) => (
          <div key={status}>
            <h2 className="font-semibold mb-3 text-sm text-base-content/70 uppercase tracking-wide">
              {STATUS_LABELS[status]}
            </h2>
            <div className="flex flex-col gap-2">
              {tasks
                ?.filter((t) => t.status === status)
                .map((task) => (
                  <div key={task.id} className="card bg-base-100 shadow-sm">
                    <div className="card-body p-3">
                      <p className="text-sm">{task.title}</p>
                      {task.assignedAgentId && (
                        <span className="badge badge-accent badge-sm self-start">
                          {task.assignedAgentId}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
