import type { Workspace, WorkspaceEvent } from "./types";

function workspaceKey(workspace: Pick<Workspace, "repoName" | "name">): string {
  return `${workspace.repoName}/${workspace.name}`;
}

export function applyWorkspaceEvent(workspaces: Workspace[], event: WorkspaceEvent): Workspace[] {
  if (event.type === "sync") return event.workspaces;
  const key = workspaceKey(event.workspace);
  if (event.type === "workspace.removed") {
    return workspaces.filter((workspace) => workspaceKey(workspace) !== key);
  }
  const existing = workspaces.findIndex((workspace) => workspaceKey(workspace) === key);
  if (existing === -1) return [...workspaces, event.workspace];
  return workspaces.map((workspace, index) => index === existing ? event.workspace : workspace);
}
