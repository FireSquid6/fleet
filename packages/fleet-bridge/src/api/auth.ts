import { Elysia, t } from "elysia";
import {
  ForbiddenError,
  parseBearer,
  UnauthenticatedError,
  UserNotFoundError,
  type AuthService,
  type Principal,
} from "../auth/auth-service";
import { principalOf } from "./guard";
import { mapErrorHook } from "./http";

export type UserPrincipal = Extract<Principal, { kind: "user" }>;

export function requirePrincipal(request: Request): Principal {
  const principal = principalOf(request);
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

export function requireUser(request: Request): UserPrincipal {
  const principal = requirePrincipal(request);
  if (principal.kind !== "user") throw new ForbiddenError("this endpoint requires a user session");
  return principal;
}

export function requireAdmin(request: Request): UserPrincipal {
  const principal = requireUser(request);
  if (principal.role !== "admin") throw new ForbiddenError("this endpoint requires an admin");
  return principal;
}

export interface AuthPluginOptions {
  insecureNoAuth?: boolean;
}

export function authPlugin(auth: AuthService, options: AuthPluginOptions = {}) {
  return new Elysia({ name: "bridge-auth" })
    .onError(mapErrorHook)
    .get("/auth/mode", () => ({ authRequired: !options.insecureNoAuth }))
    .post("/auth/login", ({ body }) => auth.login(body.username, body.password), {
      body: t.Object({ username: t.String(), password: t.String() }),
    })
    .post("/auth/logout", ({ headers }) => {
      const token = parseBearer(headers.authorization);
      if (token) auth.logout(token);
      return { ok: true as const };
    })
    .get("/auth/me", ({ request }) => {
      const principal = requireUser(request);
      const user = auth.getUser(principal.username);
      if (!user) throw new UserNotFoundError(principal.username);
      return user;
    })
    .post("/auth/ws-ticket", ({ request }) => auth.issueWsTicket(requirePrincipal(request)));
}
