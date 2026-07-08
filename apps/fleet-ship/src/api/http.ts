/**
 * api/http.ts — shared HTTP error mapping for the ship's Elysia plugins.
 *
 * A `WorkspaceError` carries the status to surface; anything else is a 500.
 */

import { WorkspaceError } from "../workspace-manager";

export function mapError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof WorkspaceError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}
