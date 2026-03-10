import { DockerClient, Filter } from "@docker/node-sdk";
import { Agent } from "../agent";
import { LocalDockerFilesystem } from "../filesystem/local-docker";
import { GitHubRepository } from "../code-repository/github";
import type { FleetStore } from "../store";

export class AgentManager {
  private running = new Map<string, Agent>();
  private store: FleetStore;
  private docker: DockerClient;

  constructor(store: FleetStore, docker: DockerClient) {
    this.store = store;
    this.docker = docker;
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

    const token = await this.store.tokens.get(project.tokenName);
    const containerId = this.containerId(projectName, agentName);
    const hostWorkspacePath = this.store.agentWorkspacePath(projectName, agentName);

    const filter = new Filter().set("reference", [agentConfig.dockerImage]);
    const matchingImages = await this.docker.imageList({ filters: filter });
    if (!matchingImages.length) {
      throw new Error(`Docker image "${agentConfig.dockerImage}" not found locally. Build it first.`);
    }

    const containerExists = await this.docker.containerInspect(containerId).then(() => true, () => false);

    if (!containerExists) {
      await Bun.$`docker create --name ${containerId} -v ${hostWorkspacePath}:${agentConfig.filesystemMountPoint} ${agentConfig.dockerImage}`.quiet();
    }

    await Bun.$`docker start ${containerId}`.quiet();

    const fs = new LocalDockerFilesystem({
      client: this.docker,
      containerId,
      hostWorkspacePath,
      containerWorkspacePath: agentConfig.filesystemMountPoint,
    });

    const repo = new GitHubRepository({
      token: token ?? "",
      owner: project.owner,
      repo: project.repository,
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
