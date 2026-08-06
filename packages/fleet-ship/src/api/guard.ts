import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { resolveBridgeToken } from "../config";

export type ShipPrincipal = { kind: "bridge" } | { kind: "agent" };

export interface ShipGuardOptions {
  bridgeToken?: string;
  agentToken?: string;
  env?: Record<string, string | undefined>;
}

const AGENT_WORKSPACE_ROUTE = /^\/workspaces\/[^/]+\/[^/]+\/agent\/(init|status)$/;

export function shipGuardPlugin(options: ShipGuardOptions = {}) {
  const bridgeToken = resolveBridgeToken(options.bridgeToken, { env: options.env });
  const expectedBridge = bridgeToken === undefined ? undefined : hash(bridgeToken);
  const expectedAgent = options.agentToken === undefined ? undefined : hash(options.agentToken);

  return new Elysia({ name: "ship-guard" }).onRequest(({ request }) => {
    if (expectedBridge === undefined) return;

    const principal = resolve(request, expectedBridge, expectedAgent);
    if (principal === null) return deny(401, "authentication required");

    const path = normalize(new URL(request.url).pathname);
    if (!mayReach(principal, request.method, path)) {
      return deny(403, `this ${principal.kind} credential may not reach ${request.method} ${path}`);
    }
  });
}

function mayReach(principal: ShipPrincipal, method: string, path: string): boolean {
  if (principal.kind === "bridge") return true;
  if (path === "/agent/credentials") return method === "GET";
  if (!AGENT_WORKSPACE_ROUTE.test(path)) return false;
  return path.endsWith("/agent/init") ? method === "POST" : method === "GET" || method === "POST";
}

function resolve(request: Request, expectedBridge: Buffer, expectedAgent?: Buffer): ShipPrincipal | null {
  const presented = parseBearer(request.headers.get("authorization"));
  if (presented === null) return null;
  const digest = hash(presented);
  if (timingSafeEqual(digest, expectedBridge)) return { kind: "bridge" };
  if (expectedAgent !== undefined && timingSafeEqual(digest, expectedAgent)) return { kind: "agent" };
  return null;
}

function hash(token: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(token).digest();
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
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
