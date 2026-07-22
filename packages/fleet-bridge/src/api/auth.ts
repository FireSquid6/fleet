/**
 * api/auth.ts — the bridge's public authentication routes.
 *
 * Kept outside the authenticated guard so a logged-out browser can reach them.
 * `login`/`bootstrap` mint a session and set the httpOnly cookie; `whoami` and
 * `ws-ticket` self-check the cookie (so they behave correctly even before the
 * global guard is enabled). One Elysia chain so its types stay inferable for Eden.
 */

import { Elysia, t } from "elysia";
import type { AuthService } from "../auth-service";
import { mapError } from "./http";
import { clearedSessionCookie, readSessionCookie, sessionCookie } from "./cookies";

export interface AuthPluginOptions {
  /** Cookie `Max-Age` / session lifetime in ms. */
  sessionTtlMs: number;
  /** Whether to mark the cookie `Secure` (production/TLS only). */
  secure: boolean;
}

const credentials = t.Object({ username: t.String(), password: t.String() });

export function authPlugin(auth: AuthService, options: AuthPluginOptions) {
  const maxAgeSeconds = options.sessionTtlMs / 1000;

  return new Elysia({ name: "bridge-auth" })
    .post(
      "/auth/login",
      async ({ body, set }) => {
        try {
          const user = await auth.verifyLogin(body.username, body.password);
          const token = await auth.createSession(user.id);
          set.headers["set-cookie"] = sessionCookie(token, maxAgeSeconds, options.secure);
          return { username: user.username };
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { body: credentials },
    )
    .post("/auth/logout", async ({ request, set }) => {
      const token = readSessionCookie(request);
      if (token) await auth.revokeSession(token);
      set.headers["set-cookie"] = clearedSessionCookie(options.secure);
      return { ok: true as const };
    })
    .get("/auth/whoami", async ({ request, set }) => {
      const user = await auth.resolveSession(readSessionCookie(request));
      if (!user) {
        set.status = 401;
        return { error: "unauthenticated" };
      }
      return { username: user.username };
    })
    .post(
      "/auth/bootstrap",
      async ({ body, set }) => {
        try {
          if ((await auth.userCount()) > 0) {
            set.status = 409;
            return { error: "already provisioned" };
          }
          const user = await auth.createUser(body.username, body.password);
          const token = await auth.createSession(user.id);
          set.headers["set-cookie"] = sessionCookie(token, maxAgeSeconds, options.secure);
          set.status = 201;
          return { username: user.username };
        } catch (err) {
          const mapped = mapError(err);
          set.status = mapped.status;
          return mapped.body;
        }
      },
      { body: credentials },
    )
    .get("/auth/ws-ticket", async ({ request, set }) => {
      const user = await auth.resolveSession(readSessionCookie(request));
      if (!user) {
        set.status = 401;
        return { error: "unauthenticated" };
      }
      return { ticket: auth.issueTicket(user.id) };
    });
}
