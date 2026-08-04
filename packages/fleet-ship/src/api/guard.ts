import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { resolveBridgeToken } from "../config";

export type ShipPrincipal = { kind: "bridge" };

export interface ShipGuardOptions {
  bridgeToken?: string;
  env?: Record<string, string | undefined>;
}

export function shipGuardPlugin(options: ShipGuardOptions = {}) {
  const token = resolveBridgeToken(options.bridgeToken, { env: options.env });
  const expected = token === undefined ? undefined : hash(token);

  return new Elysia({ name: "ship-guard" }).onRequest(({ request }) => {
    if (expected === undefined) return;
    if (!resolve(request, expected)) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  });
}

function resolve(request: Request, expected: Buffer): ShipPrincipal | null {
  const presented = parseBearer(request.headers.get("authorization"));
  if (presented === null) return null;
  return timingSafeEqual(hash(presented), expected) ? { kind: "bridge" } : null;
}

function hash(token: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(token).digest();
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}
