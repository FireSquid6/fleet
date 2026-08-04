import { Elysia, t } from "elysia";
import { ForbiddenError, type AuthService } from "../auth/auth-service";
import { requireAdmin, requireUser, type UserPrincipal } from "./auth";
import { mapErrorHook } from "./http";

const roleSchema = t.Union([t.Literal("admin"), t.Literal("member")]);

/**
 * 403 rather than 404 for an unknown target: a member is not entitled to learn
 * who exists by probing.
 */
function requireSelfOrAdmin(auth: AuthService, request: Request, username: string): UserPrincipal {
  const principal = requireUser(request);
  if (principal.role === "admin") return principal;
  const target = auth.getUser(username);
  if (!target || target.id !== principal.id) throw new ForbiddenError("you may only change your own account");
  return principal;
}

export function usersPlugin(auth: AuthService) {
  return new Elysia({ name: "bridge-users" })
    .onError(mapErrorHook)
    .get("/users", ({ request }) => {
      requireAdmin(request);
      return auth.listUsers();
    })
    .post(
      "/users",
      async ({ request, body, set }) => {
        requireAdmin(request);
        set.status = 201;
        return await auth.createUser(body);
      },
      {
        body: t.Object({
          username: t.String(),
          email: t.String(),
          password: t.String(),
          role: t.Optional(roleSchema),
        }),
      },
    )
    .delete("/users/:name", ({ request, params }) => {
      requireAdmin(request);
      auth.deleteUser(params.name);
      return { ok: true as const };
    })
    .post(
      "/users/:name/password",
      async ({ request, params, body }) => {
        requireSelfOrAdmin(auth, request, params.name);
        await auth.setPassword(params.name, body.password);
        return { ok: true as const };
      },
      { body: t.Object({ password: t.String() }) },
    )
    .post(
      "/users/:name/role",
      ({ request, params, body }) => {
        requireAdmin(request);
        return auth.setRole(params.name, body.role);
      },
      { body: t.Object({ role: roleSchema }) },
    )
    .post(
      "/users/:name/email",
      ({ request, params, body }) => {
        requireSelfOrAdmin(auth, request, params.name);
        return auth.setEmail(params.name, body.email);
      },
      { body: t.Object({ email: t.String() }) },
    );
}
