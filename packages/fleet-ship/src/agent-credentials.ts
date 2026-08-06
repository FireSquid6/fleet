import type { AgentBridgeCredential } from "fleet-protocol";

const AGENT_TOKEN_BYTES = 32;

export function generateAgentToken(): string {
  const bytes = new Uint8Array(AGENT_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export class AgentBridgeCredentialStore {
  private credential?: AgentBridgeCredential;

  set(credential: AgentBridgeCredential): void {
    this.credential = credential;
  }

  get(): AgentBridgeCredential | undefined {
    return this.credential;
  }
}
