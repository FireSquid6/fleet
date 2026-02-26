import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { covenantClient } from "../client";

export default function ProjectAgents() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: agents, loading } = covenantClient.useQuery("getProjectAgents", { projectId: projectId! });
  const [createAgent, { loading: creating, error }] = covenantClient.useMutation("createAgent");

  const [name, setName] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [toolsInput, setToolsInput] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tools = toolsInput.split(",").map((t) => t.trim()).filter(Boolean);
    await createAgent({ projectId: projectId!, name, model, tools });
    setName("");
    setToolsInput("");
  };

  return (
    <div className="p-8">
      <div role="tablist" className="tabs tabs-boxed mb-6 w-fit">
        <Link role="tab" to={`/project/${projectId}`} className="tab">
          Board
        </Link>
        <Link role="tab" to={`/project/${projectId}/agents`} className="tab tab-active">
          Agents
        </Link>
      </div>

      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Create Agent</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-md">
          <input
            className="input input-bordered"
            placeholder="Agent name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            className="input input-bordered"
            placeholder="Model (e.g. claude-sonnet-4-6)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
          />
          <input
            className="input input-bordered"
            placeholder="Tools (comma-separated, e.g. bash, git)"
            value={toolsInput}
            onChange={(e) => setToolsInput(e.target.value)}
          />
          {error && (
            <div role="alert" className="alert alert-error">
              <span>{error.message}</span>
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? "Creating..." : "Create Agent"}
          </button>
        </form>
      </div>

      <h2 className="text-lg font-semibold mb-4">Agents</h2>
      {loading && <span className="text-base-content/40">Loading...</span>}
      <div className="flex flex-col gap-3 max-w-xl">
        {agents?.map((agent) => (
          <Link key={agent.id} to={`/project/${projectId}/agents/${agent.id}`}>
            <div className="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer">
              <div className="card-body p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{agent.name}</h3>
                  <span className="badge badge-neutral">{agent.model}</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {agent.tools.map((tool) => (
                    <span key={tool} className="badge badge-outline badge-sm">{tool}</span>
                  ))}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
