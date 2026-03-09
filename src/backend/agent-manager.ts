import { DockerClient } from "@docker/node-sdk";
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

  async start(projectName: string, agentName: string): Promise<void> {
    const key = this.key(projectName, agentName);
    if (this.running.has(key)) return;

    const [project, agentConfig, instructions] = await Promise.all([
      this.store.getProject(projectName),
      this.store.getAgent(projectName, agentName),
      this.store.getAgentInstructions(projectName, agentName),
    ]);

    const token = await this.store.tokens.get(project.tokenName);

    await this.docker.containerStart(agentConfig.containerId);

    const fs = new LocalDockerFilesystem({
      client: this.docker,
      containerId: agentConfig.containerId,
      hostWorkspacePath: this.store.agentWorkspacePath(projectName, agentName),
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
    const agentConfig = await this.store.getAgent(projectName, agentName);
    await this.docker.containerStop(agentConfig.containerId);
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
