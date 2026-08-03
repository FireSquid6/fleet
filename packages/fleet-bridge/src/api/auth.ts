import { Elysia, t } from "elysia";
import {
  ForbiddenError,
  parseBearer,
  UnauthenticatedError,
  UserNotFoundError,
  type AuthService,
  type Principal,
} from "../auth/auth-service";
import { mapErrorHook } from "./http";

export type UserPrincipal = Extract<Principal, { kind: "user" }>;

export type AuthHeaders = { authorization?: string | undefined };

export function requirePrincipal(auth: AuthService, headers: AuthHeaders): Principal {
  const principal = auth.authenticate(headers.authorization);
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

export function requireUser(auth: AuthService, headers: AuthHeaders): UserPrincipal {
  const principal = requirePrincipal(auth, headers);
  if (principal.kind !== "user") throw new ForbiddenError("this endpoint requires a user session");
  return principal;
}

export function requireAdmin(auth: AuthService, headers: AuthHeaders): UserPrincipal {
  const principal = requireUser(auth, headers);
  if (principal.role !== "admin") throw new ForbiddenError("this endpoint requires an admin");
  return principal;
}

export interface AuthPluginOptions {
  insecureNoAuth?: boolean;
}

export function authPlugin(auth: AuthService, options: AuthPluginOptions = {}) {
  return new Elysia({ name: "bridge-auth" })
    .onError(mapErrorHook)
    // Unauthenticated on purpose: a client has to know whether to ask for
    // credentials before it has any.
    .get("/auth/mode", () => ({ authRequired: !options.insecureNoAuth }))
    .post("/auth/login", ({ body }) => auth.login(body.username, body.password), {
      body: t.Object({ username: t.String(), password: t.String() }),
    })
    .post("/auth/logout", ({ headers }) => {
      requirePrincipal(auth, headers);
      const token = parseBearer(headers.authorization);
      if (token) auth.logout(token);
      return { ok: true as const };
    })
    .get("/auth/me", ({ headers }) => {
      const principal = requireUser(auth, headers);
      const user = auth.getUser(principal.username);
      if (!user) throw new UserNotFoundError(principal.username);
      return user;
    })
    .post("/auth/ws-ticket", ({ headers }) => auth.issueWsTicket(requirePrincipal(auth, headers)));
}
