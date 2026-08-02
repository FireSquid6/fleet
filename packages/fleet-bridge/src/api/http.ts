import { BridgeError } from "../fleet-manager";
import { ProviderError } from "../providers";

export function mapError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof BridgeError || err instanceof ProviderError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}
