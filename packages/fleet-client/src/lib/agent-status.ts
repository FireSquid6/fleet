import type { AgentState } from "fleet-protocol";

export const AGENT_STATE_COLORS: Record<AgentState, string> = {
  idle: "var(--status-idle)",
  planning: "var(--status-planning)",
  building: "var(--status-building)",
  verifying: "var(--status-verifying)",
  awaiting: "var(--status-awaiting)",
};

export function agentStateColor(state: AgentState): string {
  return AGENT_STATE_COLORS[state];
}
