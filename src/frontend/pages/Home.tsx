import { Link } from "react-router-dom";
import { covenantClient } from "../client";

export default function Home() {
  const { data: projects, loading } = covenantClient.useCachedQuery("getProjects", null, true);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-1">Fleet</h1>
      <p className="text-base-content/60 mb-8">Manage your AI-powered development projects</p>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Running Agents</h2>
        <div role="alert" className="alert alert-info">
          <span>No agents currently running.</span>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Projects</h2>
        {loading && <span className="text-base-content/40">Loading...</span>}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects?.map((project) => (
            <Link key={project.id} to={`/project/${project.id}`}>
              <div className="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer">
                <div className="card-body">
                  <h3 className="card-title text-base">{project.name}</h3>
                  <p className="text-sm text-base-content/60 truncate">{project.repoUrl}</p>
                  <p className="text-xs text-base-content/40">{project.dockerImage}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
