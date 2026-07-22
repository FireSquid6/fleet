/**
 * api/cookies.ts — minimal session-cookie read/write.
 *
 * The session token is opaque and validated by a `Store` lookup, so the cookie
 * needs no signing — plain parse/serialize is enough and keeps us off any
 * framework-specific cookie API. `secure` is gated by the caller (off in dev
 * over plain http, on in production behind TLS).
 */

export const SESSION_COOKIE = "fleet_session";

/** Read the session token from a request's `Cookie` header, or `undefined`. */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** `Set-Cookie` value that installs the session token. */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** `Set-Cookie` value that clears the session cookie (logout). */
export function clearedSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
