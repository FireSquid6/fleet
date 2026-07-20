import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseFleetIdentifier } from "fleet-protocol";

export class ContainedPathError extends Error {}
export class CloneDestinationExistsError extends ContainedPathError {}

function assertDescendant(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ContainedPathError(`path is outside fleet directory: ${path}`);
  }
}

export function containedPath(root: string, ...components: string[]): string {
  for (const component of components) parseFleetIdentifier(component);
  const path = resolve(root, ...components);
  assertDescendant(root, path);
  return path;
}

async function assertDirectory(root: string, path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new ContainedPathError(`symbolic links are not allowed: ${path}`);
  if (!info.isDirectory()) throw new ContainedPathError(`not a directory: ${path}`);
  const canonical = await realpath(path);
  assertDescendant(root, canonical);
  return canonical;
}

export async function existingWorkspacePath(root: string, repoName: string, name: string): Promise<string> {
  await existingRepoPath(root, repoName);
  return assertDirectory(root, containedPath(root, repoName, name));
}

export function existingRepoPath(root: string, repoName: string): Promise<string> {
  return assertDirectory(root, containedPath(root, repoName));
}

export async function ensureRepoPath(root: string, repoName: string): Promise<string> {
  const repo = containedPath(root, repoName);
  try {
    await mkdir(repo);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return assertDirectory(root, repo);
}

export async function assertCloneDestinationAvailable(root: string, repoName: string, name: string): Promise<string> {
  const repo = await ensureRepoPath(root, repoName);
  const destination = containedPath(root, repoName, name);
  assertDescendant(repo, destination);
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
    throw error;
  }
  throw new CloneDestinationExistsError(`clone destination already exists: ${repoName}/${name}`);
}
