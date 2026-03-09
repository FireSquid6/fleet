import YAML from "yaml";
import { z } from "zod";
import { join, resolve } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { TokenStore } from "./token";
import { projectSchema, agentSchema } from "../covenant";

export { TokenStore, projectSchema, agentSchema };

export type Project = z.infer<typeof projectSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;

// Directory layout:
//
//   {root}/
//     tokens.yaml
//     projects/
//       {project}/
//         project.yaml
//         {agent}/
//           agent.yaml
//           AGENT.md
//           workspace/

export class FleetStore {
  private root: string;
  readonly tokens: TokenStore;

  constructor(directory: string) {
    this.root = resolve(directory);
    this.tokens = new TokenStore(join(this.root, "tokens.yaml"));
  }

  // Ensures the base directory structure exists. Call once on startup.
  async initialize(): Promise<void> {
    await mkdir(join(this.root, "projects"), { recursive: true });
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(): Promise<string[]> {
    const entries = await readdir(join(this.root, "projects"), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  async getProject(name: string): Promise<Project> {
    const text = await Bun.file(this.projectYaml(name)).text();
    return projectSchema.parse(YAML.parse(text));
  }

  async createProject(name: string, data: Project): Promise<void> {
    const dir = this.projectDir(name);
    await mkdir(dir, { recursive: true });
    await Bun.write(this.projectYaml(name), YAML.stringify(projectSchema.parse(data)));
  }

  async updateProject(name: string, data: Partial<Project>): Promise<void> {
    const existing = await this.getProject(name);
    const updated = projectSchema.parse({ ...existing, ...data });
    await Bun.write(this.projectYaml(name), YAML.stringify(updated));
  }

  async deleteProject(name: string): Promise<void> {
    await rm(this.projectDir(name), { recursive: true, force: true });
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async listAgents(projectName: string): Promise<string[]> {
    const entries = await readdir(this.projectDir(projectName), { withFileTypes: true });
    // agent dirs sit alongside project.yaml, so filter out files
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  async getAgent(projectName: string, agentName: string): Promise<AgentConfig> {
    const text = await Bun.file(this.agentYaml(projectName, agentName)).text();
    return agentSchema.parse(YAML.parse(text));
  }

  async createAgent(projectName: string, agentName: string, data: AgentConfig): Promise<void> {
    const dir = this.agentDir(projectName, agentName);
    await mkdir(join(dir, "workspace"), { recursive: true });
    await Bun.write(this.agentYaml(projectName, agentName), YAML.stringify(agentSchema.parse(data)));
    await Bun.write(join(dir, "AGENT.md"), "");
  }

  async updateAgent(projectName: string, agentName: string, data: Partial<AgentConfig>): Promise<void> {
    const existing = await this.getAgent(projectName, agentName);
    const updated = agentSchema.parse({ ...existing, ...data });
    await Bun.write(this.agentYaml(projectName, agentName), YAML.stringify(updated));
  }

  async deleteAgent(projectName: string, agentName: string): Promise<void> {
    await rm(this.agentDir(projectName, agentName), { recursive: true, force: true });
  }

  // ── Agent instructions (AGENT.md) ─────────────────────────────────────────

  async getAgentInstructions(projectName: string, agentName: string): Promise<string> {
    return Bun.file(join(this.agentDir(projectName, agentName), "AGENT.md")).text();
  }

  async setAgentInstructions(projectName: string, agentName: string, instructions: string): Promise<void> {
    await Bun.write(join(this.agentDir(projectName, agentName), "AGENT.md"), instructions);
  }

  // ── Paths ─────────────────────────────────────────────────────────────────

  // Absolute path to the agent's workspace on the host
  agentWorkspacePath(projectName: string, agentName: string): string {
    return join(this.agentDir(projectName, agentName), "workspace");
  }

  private projectDir(name: string): string {
    return join(this.root, "projects", name);
  }

  private projectYaml(name: string): string {
    return join(this.projectDir(name), "project.yaml");
  }

  private agentDir(projectName: string, agentName: string): string {
    return join(this.projectDir(projectName), agentName);
  }

  private agentYaml(projectName: string, agentName: string): string {
    return join(this.agentDir(projectName, agentName), "agent.yaml");
  }
}
