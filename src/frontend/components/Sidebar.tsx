import { NavLink } from "react-router-dom";
import { FolderIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import { covenantClient } from "../client";

export default function Sidebar() {
  const { data: projects, loading } = covenantClient.useCachedQuery("getProjects", null, true);

  return (
    <aside className="w-60 bg-base-200 flex flex-col p-3 gap-1 shrink-0">
      <div className="flex items-center gap-2 px-2 py-1 text-sm font-semibold text-base-content/60 uppercase tracking-wider">
        <FolderIcon className="h-4 w-4" />
        Projects
      </div>

      {loading && <span className="px-2 text-sm text-base-content/40">Loading...</span>}

      {projects?.map((project) => (
        <NavLink
          key={project.id}
          to={`/project/${project.id}`}
          className={({ isActive }) =>
            `btn btn-ghost btn-sm justify-start ${isActive ? "btn-active" : ""}`
          }
        >
          {project.name}
        </NavLink>
      ))}

      <NavLink
        to="/new-project"
        className={({ isActive }) =>
          `btn btn-ghost btn-sm justify-start ${isActive ? "btn-active" : ""}`
        }
      >
        + New Project
      </NavLink>

      <div className="divider my-1" />

      <NavLink
        to="/armory"
        className={({ isActive }) =>
          `btn btn-ghost btn-sm justify-start ${isActive ? "btn-active" : ""}`
        }
      >
        <ShieldCheckIcon className="h-4 w-4" />
        Armory
      </NavLink>
    </aside>
  );
}
