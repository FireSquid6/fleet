import YAML from "yaml";
import { z } from "zod";
import { join, resolve } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { TokenStore, mergeTokenFiles } from "./token";
import { projectSchema, agentSchema } from "../covenant";

export { TokenStore, projectSchema, agentSchema };

export type Project = z.infer<typeof projectSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;

// Directory layout:
//
//   {root}/
//     providers.yaml        ← AI provider keys (ANTHROPIC_API_KEY, etc.) — Fleet server only
//     tokens.yaml           ← global tokens available to all agents
//     projects/
//       {project}/
//         project.yaml
//         tokens.yaml       ← project-scoped tokens (merged on top of root)
//         {agent}/
//           agent.yaml
//           tokens.yaml     ← agent-scoped tokens (merged on top of project)
//           AGENT.md
//           workspace/

export class FleetStore {
  private root: string;
  // Root-level tokens available to all agents
  readonly tokens: TokenStore;
  // AI provider keys (ANTHROPIC_API_KEY, etc.) — not exposed to agents
  readonly providers: TokenStore;

  constructor(directory: string) {
    this.root = resolve(directory);
    this.tokens = new TokenStore(join(this.root, "tokens.yaml"));
    this.providers = new TokenStore(join(this.root, "providers.yaml"));
  }

  // Ensures the base directory structure exists. Call once on startup.
  async initialize(): Promise<void> {
    await mkdir(join(this.root, "projects"), { recursive: true });
    const rootAgentMd = join(this.root, "AGENT.md");
    if (!(await Bun.file(rootAgentMd).exists())) {
      await Bun.write(rootAgentMd, ROOT_AGENT_MD_DEFAULT);
    }
  }

  // Per-scope token stores (for direct read/write to a specific level)
  projectTokens(projectName: string): TokenStore {
    return new TokenStore(join(this.projectDir(projectName), "tokens.yaml"));
  }

  agentTokens(projectName: string, agentName: string): TokenStore {
    return new TokenStore(join(this.agentDir(projectName, agentName), "tokens.yaml"));
  }

  // Resolves the full token set visible to an agent: root → project → agent.
  // Later scopes override earlier ones with the same key.
  async resolveAgentTokens(projectName: string, agentName: string): Promise<Record<string, string>> {
    return mergeTokenFiles(
      join(this.root, "tokens.yaml"),
      join(this.projectDir(projectName), "tokens.yaml"),
      join(this.agentDir(projectName, agentName), "tokens.yaml"),
    );
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
    await Bun.write(join(dir, "AGENT.md"), "");
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

  // ── Instructions (AGENT.md) ───────────────────────────────────────────────

  async getRootInstructions(): Promise<string> {
    return Bun.file(join(this.root, "AGENT.md")).text();
  }

  async setRootInstructions(instructions: string): Promise<void> {
    await Bun.write(join(this.root, "AGENT.md"), instructions);
  }

  async getProjectInstructions(projectName: string): Promise<string> {
    return Bun.file(join(this.projectDir(projectName), "AGENT.md")).text();
  }

  async setProjectInstructions(projectName: string, instructions: string): Promise<void> {
    await Bun.write(join(this.projectDir(projectName), "AGENT.md"), instructions);
  }

  async getAgentInstructions(projectName: string, agentName: string): Promise<string> {
    return Bun.file(join(this.agentDir(projectName, agentName), "AGENT.md")).text();
  }

  async setAgentInstructions(projectName: string, agentName: string, instructions: string): Promise<void> {
    await Bun.write(join(this.agentDir(projectName, agentName), "AGENT.md"), instructions);
  }

  // Concatenates root → project → agent AGENT.md files, skipping empty sections.
  async resolveAgentInstructions(projectName: string, agentName: string): Promise<string> {
    const [root, project, agent] = await Promise.all([
      this.getRootInstructions().catch(() => ""),
      this.getProjectInstructions(projectName).catch(() => ""),
      this.getAgentInstructions(projectName, agentName).catch(() => ""),
    ]);
    return [root, project, agent].filter(s => s.trim()).join("\n\n");
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

const ROOT_AGENT_MD_DEFAULT = `\
You are a coding agent. You have access to a filesystem and a code repository.

Use your tools to read, write, and edit files, run commands, search code, manage git repository \
tasks (pull requests, issues, CI checks), and start or stop processes as needed.

When writing or editing code:
- Read existing files before modifying them
- Make targeted, minimal changes
- Run tests or build commands after making changes to verify correctness
- Prefer editing existing files over creating new ones

When using the filesystem, all paths are relative to the workspace root.
`;
