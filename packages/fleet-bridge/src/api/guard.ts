import { Elysia } from "elysia";
import type { AuthService, Principal } from "../auth/auth-service";

const principals = new WeakMap<Request, Principal>();

export function principalOf(request: Request): Principal | undefined {
  return principals.get(request);
}

const PUBLIC_ROUTES = new Set([
  "POST /auth/login",
  "GET /auth/mode",
  "POST /auth/logout",
]);

export const TEMPORARILY_PUBLIC_UNTIL_SHIP_TOKENS = new Set(["GET /armory", "GET /armory/file"]);

const INSECURE_ADMIN: Principal = {
  kind: "user",
  id: "insecure-no-auth",
  username: "insecure-no-auth",
  role: "admin",
};

export interface GuardOptions {
  insecureNoAuth?: boolean;
}

export function guardPlugin(auth: AuthService, options: GuardOptions = {}) {
  return new Elysia({ name: "bridge-guard" }).onRequest(({ request }) => {
    const url = new URL(request.url);
    const path = normalize(url.pathname);
    const route = `${request.method} ${path}`;
    if (PUBLIC_ROUTES.has(route) || TEMPORARILY_PUBLIC_UNTIL_SHIP_TOKENS.has(route)) return;

    const principal = resolve(auth, request, url, options);
    if (!principal) return deny(401, "authentication required");
    if (!mayReach(principal, request.method, path)) {
      return deny(403, `a ${principal.kind} credential may not reach ${route}`);
    }
    principals.set(request, principal);
  });
}

function resolve(auth: AuthService, request: Request, url: URL, options: GuardOptions): Principal | null {
  if (options.insecureNoAuth) return INSECURE_ADMIN;

  const fromHeader = auth.authenticate(request.headers.get("authorization"));
  if (fromHeader) return fromHeader;

  // Upgrade-only: tickets are single-use, so any stray `?ticket=` link would burn one.
  const ticket = url.searchParams.get("ticket");
  if (ticket && isUpgrade(request)) return auth.redeemWsTicket(ticket);

  return null;
}

function mayReach(principal: Principal, method: string, path: string): boolean {
  switch (principal.kind) {
    case "user":
      return true;
    case "ship":
      return method === "GET" && (path === "/armory" || path === "/armory/file");
    case "ship-agent":
      return path === "/repos" || path.startsWith("/repos/");
  }
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
