import { FleetIdentifierSchema } from "fleet-protocol";

export const WORKSPACE_TMUX_NAMESPACE = "fleet-ship";

const encoder = new TextEncoder();
const ENCODING_VERSION = 1;

/** V1 hashes `version || u32be(repo bytes) || repo || u32be(workspace bytes) || workspace`. */
export function workspaceSessionName(repoName: string, workspaceName: string): string {
  FleetIdentifierSchema.parse(repoName);
  FleetIdentifierSchema.parse(workspaceName);

  const repo = encoder.encode(repoName);
  const workspace = encoder.encode(workspaceName);
  const identity = new Uint8Array(1 + 4 + repo.byteLength + 4 + workspace.byteLength);
  const view = new DataView(identity.buffer);

  identity[0] = ENCODING_VERSION;
  view.setUint32(1, repo.byteLength);
  identity.set(repo, 5);
  view.setUint32(5 + repo.byteLength, workspace.byteLength);
  identity.set(workspace, 9 + repo.byteLength);

  const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex");
  return `ws-${digest}`;
}
