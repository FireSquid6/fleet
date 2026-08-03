import { InvalidCookieSignature, InvalidFileType, NotFoundError, ParseError, ValidationError } from "elysia";
import { ZodError } from "zod";
import { AuthError } from "../auth/auth-service";
import { BridgeError } from "../fleet-manager";
import { ProviderError } from "../providers";

export function mapError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof BridgeError || err instanceof ProviderError || err instanceof AuthError) {
    return { status: err.status, body: { error: err.message } };
  }
  // Services validate with zod (usernames, emails, passwords, config), and a
  // value the caller got wrong is their error, not a server fault.
  if (err instanceof ZodError) {
    return { status: 400, body: { error: describeZodError(err) } };
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}

function describeZodError(err: ZodError): string {
  const issues = err.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );
  return `invalid request — ${issues.join("; ")}`;
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
