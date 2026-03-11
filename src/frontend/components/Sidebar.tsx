import { NavLink, Link } from "react-router-dom";
import { Cog6ToothIcon, PlusIcon } from "@heroicons/react/24/outline";
import { client } from "../client";

export default function Sidebar() {
  const { data: projects, loading } = client.useListenedQuery("listProjects", null);

  return (
    <aside className="w-56 shrink-0 bg-base-200 flex flex-col h-full border-r border-base-300">
      <div className="px-4 py-5 border-b border-base-300">
        <Link to="/" className="text-lg font-bold tracking-wide hover:text-primary transition-colors">
          Autosmith
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <div className="flex items-center justify-between px-2 pt-3 pb-1">
          <span className="text-xs font-semibold uppercase tracking-widest text-base-content/40">
            Projects
          </span>
          <Link
            to="/projects/new"
            className="btn btn-ghost btn-xs"
            title="New project"
          >
            <PlusIcon className="w-3.5 h-3.5" />
          </Link>
        </div>

        {loading && (
          <div className="flex justify-center py-4">
            <span className="loading loading-spinner loading-sm" />
          </div>
        )}

        {projects?.map((project) => (
          <NavLink
            key={project.name}
            to={`/projects/${project.name}`}
            className={({ isActive }) =>
              `block px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-primary text-primary-content font-medium"
                  : "hover:bg-base-300 text-base-content"
              }`
            }
          >
            {project.name}
          </NavLink>
        ))}

        {!loading && projects?.length === 0 && (
          <p className="text-xs text-base-content/40 px-3 py-2 italic">No projects yet</p>
        )}
      </nav>

      <div className="p-2 border-t border-base-300">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive
                ? "bg-primary text-primary-content font-medium"
                : "hover:bg-base-300 text-base-content"
            }`
          }
        >
          <Cog6ToothIcon className="w-4 h-4" />
          Settings
        </NavLink>
      </div>
    </aside>
  );
}
