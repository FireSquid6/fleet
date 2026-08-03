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

/** Only the header the principal is resolved from; Elysia hands us the whole bag. */
export type AuthHeaders = { authorization?: string | undefined };

/**
 * The single place a request turns into a principal. Routes are still opt-in
 * (there is no global guard yet), so every authenticated handler goes through
 * here and only this function changes when the guard lands.
 */
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

export function authPlugin(auth: AuthService) {
  return new Elysia({ name: "bridge-auth" })
    .onError(mapErrorHook)
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
