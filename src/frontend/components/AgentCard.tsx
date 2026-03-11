import { Link } from "react-router-dom";
import { client } from "../client";

interface AgentCardProps {
  projectName: string;
  agentName: string;
  provider: string;
  dockerImage: string;
}

export default function AgentCard({ projectName, agentName, provider, dockerImage }: AgentCardProps) {
  const { data: isRunning } = client.useQuery("isAgentRunning", { projectName, agentName });

  return (
    <Link
      to={`/projects/${projectName}/agents/${agentName}`}
      className="card bg-base-200 border border-base-300 hover:border-primary/40 hover:shadow-md transition-all cursor-pointer"
    >
      <div className="card-body p-4 gap-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="card-title text-base leading-tight">{agentName}</h3>
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isRunning ? "bg-success/20 text-success" : "bg-base-300 text-base-content/50"
            }`}
          >
            {isRunning === undefined ? "…" : isRunning ? "running" : "stopped"}
          </span>
        </div>
        <p className="text-sm text-base-content/60">{provider}</p>
        <p className="text-xs text-base-content/40 font-mono truncate">{dockerImage}</p>
      </div>
    </Link>
  );
}
