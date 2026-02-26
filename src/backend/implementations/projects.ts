import { server } from "../server";

const dummyProjects = [
  {
    id: "proj-1",
    name: "fleet",
    repoUrl: "https://github.com/example/fleet",
    dockerImage: "node:20",
    subdirectory: undefined,
  },
  {
    id: "proj-2",
    name: "api-gateway",
    repoUrl: "https://github.com/example/api-gateway",
    dockerImage: "python:3.12",
    subdirectory: "backend",
  },
];

export default function defineProjects() {
  server.defineProcedure("getProjects", {
    resources: () => ["projects"],
    procedure: () => dummyProjects,
  });

  server.defineProcedure("getProject", {
    resources: ({ inputs }) => [`project/${inputs.id}`],
    procedure: ({ inputs, error }) => {
      const project = dummyProjects.find((p) => p.id === inputs.id);
      if (!project) error("Project not found", 404);
      return project!;
    },
  });

  server.defineProcedure("createProject", {
    resources: ({ outputs }) => ["projects", `project/${outputs.id}`],
    procedure: ({ inputs }) => {
      const name = inputs.repoUrl.split("/").pop() ?? inputs.repoUrl;
      const project = {
        id: `proj-${Date.now()}`,
        name,
        repoUrl: inputs.repoUrl,
        dockerImage: inputs.dockerImage,
        subdirectory: inputs.subdirectory,
      };
      dummyProjects.push(project);
      return project;
    },
  });
}
