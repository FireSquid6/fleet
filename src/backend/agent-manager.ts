import { Agent } from "../agent";
import { LocalDockerFilesystem } from "../filesystem/local-docker";
import { GitHubRepository } from "../code-repository/github";
import type { FleetStore } from "../store";

export class AgentManager {
  private running = new Map<string, Agent>();
  private store: FleetStore;

  constructor(store: FleetStore) {
    this.store = store;
  }

  private async imageExists(image: string): Promise<boolean> {
    const result = await Bun.$`docker image inspect ${image}`.quiet().catch(() => null);
    return result !== null && result.exitCode === 0;
  }

  // Writes a git credential store file into the container and configures git to use it,
  // so any git command the agent runs against that provider's host is authenticated.
  private async configureGitCredentials(containerId: string, credentialEntry: string): Promise<void> {
    const tmpPath = `/tmp/fleet-git-creds-${containerId}`;
    await Bun.write(tmpPath, credentialEntry + "\n");
    try {
      await Bun.$`docker cp ${tmpPath} ${containerId}:/root/.git-credentials`.quiet();
      await Bun.$`docker exec ${containerId} git config --global credential.helper store`.quiet();
    } finally {
      await Bun.$`rm -f ${tmpPath}`;
    }
  }

  private async containerExists(id: string): Promise<boolean> {
    const result = await Bun.$`docker container inspect ${id}`.quiet().catch(() => null);
    return result !== null && result.exitCode === 0;
  }

  private key(projectName: string, agentName: string): string {
    return `${projectName}/${agentName}`;
  }

  private containerId(projectName: string, agentName: string): string {
    return `fleet-${projectName}-${agentName}`;
  }

  async start(projectName: string, agentName: string): Promise<void> {
    const key = this.key(projectName, agentName);
    if (this.running.has(key)) return;

    const [project, agentConfig, instructions] = await Promise.all([
      this.store.getProject(projectName),
      this.store.getAgent(projectName, agentName),
      this.store.getAgentInstructions(projectName, agentName),
    ]);

    const agentTokens = await this.store.resolveAgentTokens(projectName, agentName);
    const token = agentTokens[project.tokenName];
    const containerId = this.containerId(projectName, agentName);
    const hostWorkspacePath = this.store.agentWorkspacePath(projectName, agentName);

    if (!await this.imageExists(agentConfig.dockerImage)) {
      throw new Error(`Docker image "${agentConfig.dockerImage}" not found locally. Build it first.`);
    }

    const repo = new GitHubRepository({
      token: token ?? "",
      owner: project.owner,
      repo: project.repository,
    });

    const authenticatedUrl = repo.getAuthenticatedUrl(token ?? "");

    const workspaceExists = await Bun.file(`${hostWorkspacePath}/.git/HEAD`).exists();
    if (workspaceExists) {
      // Always refresh the remote URL so a rotated token doesn't break pulls
      await Bun.$`git -C ${hostWorkspacePath} remote set-url origin ${authenticatedUrl}`.quiet();
      await Bun.$`git -C ${hostWorkspacePath} pull`.quiet();
    } else {
      await Bun.$`git clone ${authenticatedUrl} ${hostWorkspacePath}`.quiet();
    }

    if (!await this.containerExists(containerId)) {
      await Bun.$`docker create --name ${containerId} -v ${hostWorkspacePath}:${agentConfig.filesystemMountPoint} ${agentConfig.dockerImage}`.quiet();
    }

    await Bun.$`docker start ${containerId}`.quiet();
    await this.configureGitCredentials(containerId, repo.getCredentialStoreEntry(token ?? ""));

    const fs = new LocalDockerFilesystem({
      containerId,
      hostWorkspacePath,
      containerWorkspacePath: agentConfig.filesystemMountPoint,
    });

    const agent = new Agent({ id: key, fs, repo, instructions });
    this.running.set(key, agent);
  }

  async stop(projectName: string, agentName: string): Promise<void> {
    const key = this.key(projectName, agentName);
    this.running.delete(key);
    await Bun.$`docker stop ${this.containerId(projectName, agentName)}`.quiet();
  }

  get(projectName: string, agentName: string): Agent | undefined {
    return this.running.get(this.key(projectName, agentName));
  }

  isRunning(projectName: string, agentName: string): boolean {
    return this.running.has(this.key(projectName, agentName));
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.running.keys()].map(key => {
        const slash = key.indexOf("/");
        return this.stop(key.slice(0, slash), key.slice(slash + 1));
      }),
    );
  }
}
