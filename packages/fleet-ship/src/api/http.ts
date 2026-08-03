import { InvalidCookieSignature, InvalidFileType, NotFoundError, ParseError, ValidationError } from "elysia";
import { WorkspaceError } from "../workspace-manager";

export function mapError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof WorkspaceError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}

type ErrorContext = { error: unknown; set: { status?: number | string } };

/**
 * Elysia raises its own errors (validation, parse, unmatched route) around the
 * handler rather than inside it, so they were unreachable from the per-route
 * `try`/`catch` this hook replaces. Returning `undefined` leaves them to
 * Elysia's own rendering — mapping them would turn a 422 into a 500.
 */
export function errorHook(map: (err: unknown) => { status: number; body: { error: string } }) {
  return ({ error, set }: ErrorContext) => {
    if (
      error instanceof ValidationError ||
      error instanceof NotFoundError ||
      error instanceof ParseError ||
      error instanceof InvalidCookieSignature ||
      error instanceof InvalidFileType
    ) {
      return;
    }
    const mapped = map(error);
    set.status = mapped.status;
    return mapped.body;
  };
}

export const mapErrorHook = errorHook(mapError);
