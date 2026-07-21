import type { AgentStatus } from "fleet-protocol";
import type { WorkspaceLocation } from "./agent-workspace";

async function post(location: WorkspaceLocation, path: string, body: unknown): Promise<AgentStatus> {
  const url = `${location.baseUrl}/workspaces/${encodeURIComponent(location.repo)}/${encodeURIComponent(location.name)}/${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error(`fleet agent: could not reach ship at ${location.baseUrl}: ${(error as Error).message}`);
    process.exit(1);
  }

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : text;
    console.error(`fleet agent: request failed (${response.status}): ${message}`);
    process.exit(1);
  }
  return parsed as AgentStatus;
}

export function initAgent(
  location: WorkspaceLocation,
  body: { model: string; provider: string; harness: string },
): Promise<AgentStatus> {
  return post(location, "agent/init", body);
}

export function updateStatus(
  location: WorkspaceLocation,
  body: { state: string; description: string },
): Promise<AgentStatus> {
  return post(location, "agent/status", body);
}
