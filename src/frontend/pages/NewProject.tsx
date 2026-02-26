import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { covenantClient } from "../client";

export default function NewProject() {
  const navigate = useNavigate();
  const [createProject, { loading, error }] = covenantClient.useMutation("createProject", {
    onSuccess: (project) => navigate(`/project/${project.id}`),
  });

  const [repoUrl, setRepoUrl] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [subdirectory, setSubdirectory] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createProject({
      repoUrl,
      dockerImage,
      subdirectory: subdirectory || undefined,
    });
  };

  return (
    <div className="p-8 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">New Project</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text">Repository URL</span>
          </label>
          <input
            type="url"
            className="input input-bordered"
            placeholder="https://github.com/example/repo"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            required
          />
        </div>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Docker Image</span>
          </label>
          <input
            className="input input-bordered"
            placeholder="node:20"
            value={dockerImage}
            onChange={(e) => setDockerImage(e.target.value)}
            required
          />
        </div>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Subdirectory (optional)</span>
          </label>
          <input
            className="input input-bordered"
            placeholder="backend"
            value={subdirectory}
            onChange={(e) => setSubdirectory(e.target.value)}
          />
        </div>

        {error && (
          <div role="alert" className="alert alert-error">
            <span>{error.message}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? "Creating..." : "Create Project"}
        </button>
      </form>
    </div>
  );
}
