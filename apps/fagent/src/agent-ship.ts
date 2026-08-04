import { AgentBridgeCredentialSchema, type AgentBridgeCredential, type AgentStatus } from "fleet-protocol";
import type { WorkspaceLocation } from "./agent-workspace";

function fail(message: string): never {
  console.error(`fagent: ${message}`);
  process.exit(1);
}

function refused(location: WorkspaceLocation, status: number): never {
  return fail(
    location.agentToken === undefined
      ? `the ship refused this request (${status}) and atlas.json carries no agentToken; ` +
          "restart the ship so it writes one"
      : `the ship refused this workspace's agent token (${status}); ` +
          "restart the ship so it writes a fresh one to atlas.json",
  );
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorText(parsed: unknown, text: string): string {
  return parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : text;
}

async function request(
  location: WorkspaceLocation,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; parsed: unknown; text: string }> {
  const headers = location.agentToken === undefined
    ? init?.headers
    : { ...init?.headers, authorization: `Bearer ${location.agentToken}` };

  let response: Response;
  try {
    response = await fetch(`${location.baseUrl}${path}`, { ...init, headers });
  } catch (error) {
    fail(`could not reach ship at ${location.baseUrl}: ${(error as Error).message}`);
  }

  const text = await response.text();
  if (response.status === 401 || response.status === 403) refused(location, response.status);
  return { status: response.status, ok: response.ok, parsed: parseBody(text), text };
}

async function post(location: WorkspaceLocation, path: string, body: unknown): Promise<AgentStatus> {
  const workspace = `/workspaces/${encodeURIComponent(location.repo)}/${encodeURIComponent(location.name)}`;
  const { ok, status, parsed, text } = await request(location, `${workspace}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!ok) fail(`request failed (${status}): ${errorText(parsed, text)}`);
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

export async function fetchBridgeCredential(location: WorkspaceLocation): Promise<AgentBridgeCredential> {
  const { ok, status, parsed, text } = await request(location, "/agent/credentials");
  if (status === 503) {
    fail(`${errorText(parsed, text)}; connect this ship to a bridge, or pass --bridge-url to reach one directly`);
  }
  if (!ok) fail(`request failed (${status}): ${errorText(parsed, text)}`);

  const credential = AgentBridgeCredentialSchema.safeParse(parsed);
  if (!credential.success) fail(`the ship at ${location.baseUrl} returned an unusable bridge credential`);
  return credential.data;
}
