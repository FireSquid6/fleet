import { useState } from "react";

export type ExtendedTask = {
  id: string;
  title: string;
  status: "todo" | "in-progress" | "done";
  assignedAgentId?: string;
  description: string;
  plan?: string;
};

type Agent = { id: string; name: string; model: string };

type Props = {
  task: ExtendedTask;
  agents: Agent[];
  onClose: () => void;
  onAssign: (taskId: string, agentId: string) => void;
};

const STATUS_BADGE: Record<string, string> = {
  "todo": "badge-neutral",
  "in-progress": "badge-warning",
  "done": "badge-success",
};
const STATUS_LABEL: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "done": "Done",
};

export default function TaskDetail({ task, agents, onClose, onAssign }: Props) {
  const [selectedAgentId, setSelectedAgentId] = useState(task.assignedAgentId ?? "");

  const assignedAgent = agents.find((a) => a.id === task.assignedAgentId);

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-2xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <h2 className="text-xl font-bold">{task.title}</h2>
          <span className={`badge ${STATUS_BADGE[task.status]} shrink-0`}>
            {STATUS_LABEL[task.status]}
          </span>
        </div>

        <p className="text-base-content/70 mb-6">{task.description}</p>

        {/* Assigned agent section */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/50 mb-2">
            Assigned Agent
          </h3>
          {task.status === "todo" ? (
            <div className="flex items-center gap-2">
              <select
                className="select select-bordered select-sm flex-1"
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
              >
                <option value="">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.model})
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm btn-primary"
                disabled={!selectedAgentId || selectedAgentId === task.assignedAgentId}
                onClick={() => onAssign(task.id, selectedAgentId)}
              >
                Assign
              </button>
            </div>
          ) : assignedAgent ? (
            <div className="flex items-center gap-2">
              <span className="badge badge-accent">{assignedAgent.name}</span>
              <span className="text-sm text-base-content/50">{assignedAgent.model}</span>
            </div>
          ) : (
            <span className="text-sm text-base-content/40">None</span>
          )}
        </div>

        {/* Plan section — shown for todo tasks */}
        {task.status === "todo" && (
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/50 mb-2">
              Agent Plan
            </h3>
            {task.plan ? (
              <div className="bg-base-200 rounded-lg p-4 text-sm whitespace-pre-wrap font-mono leading-relaxed">
                {task.plan}
              </div>
            ) : (
              <p className="text-sm text-base-content/40 italic">
                Assign an agent to generate a plan.
              </p>
            )}
          </div>
        )}

        <div className="modal-action">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </dialog>
  );
}
