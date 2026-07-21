import { Command } from "commander";
import { AGENT_STATES, type AgentState } from "fleet-protocol";
import { initAgent, updateStatus } from "./agent-ship";
import { findWorkspace, type WorkspaceLocation } from "./agent-workspace";

async function requireWorkspace(): Promise<WorkspaceLocation> {
  const location = await findWorkspace();
  if (location === null) {
    console.error("fleet agent: not inside a fleet workspace");
    process.exit(1);
  }
  return location;
}

export const agentCommand = new Command()
  .name("agent")
  .description("Workspace reporting commands for agents, not necessarily humans");

agentCommand
  .command("init")
  .description("start an agent session on this workspace (sets status to idle)")
  .requiredOption("--model <model>", "model driving the agent, e.g. claude-opus-4-8")
  .requiredOption("--provider <provider>", "model provider, e.g. anthropic")
  .requiredOption("--harness <harness>", "agent harness, e.g. claude-code")
  .action(async (options: { model: string; provider: string; harness: string }) => {
    const location = await requireWorkspace();
    const status = await initAgent(location, options);
    console.log(`agent session started on ${location.repo}/${location.name} (${status.state})`);
  });

agentCommand
  .command("status")
  .description("update this workspace's agent status")
  .argument("<state>", `one of: ${AGENT_STATES.join(", ")}`)
  .requiredOption("-d, --description <text>", "short summary of what you're doing (100-200 characters)")
  .action(async (state: string, options: { description: string }) => {
    if (!(AGENT_STATES as readonly string[]).includes(state)) {
      console.error(`fleet agent: invalid state "${state}"; expected one of: ${AGENT_STATES.join(", ")}`);
      process.exit(1);
    }
    const location = await requireWorkspace();
    const status = await updateStatus(location, { state: state as AgentState, description: options.description });
    console.log(`status updated to ${status.state} on ${location.repo}/${location.name}`);
  });

agentCommand
  .command("in-workspace")
  .description("check whether the current directory is inside a fleet workspace")
  .action(async () => {
    const location = await findWorkspace();
    if (location === null) {
      console.log("no workspace");
      process.exit(1);
    }
    console.log(`${location.repo}/${location.name}`);
  });
