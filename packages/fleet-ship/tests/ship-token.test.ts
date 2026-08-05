import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { SHIP_TOKEN_ENV_VAR, resolveShipToken } from "../src/config";
import { stubConfig, stubManager } from "./helpers";

describe("resolveShipToken", () => {
  test("prefers the configured token over the environment", () => {
    expect(resolveShipToken("configured", { env: { [SHIP_TOKEN_ENV_VAR]: "from-env" } })).toBe("configured");
  });

  test("falls back to the environment", () => {
    expect(resolveShipToken(undefined, { env: { [SHIP_TOKEN_ENV_VAR]: "from-env" } })).toBe("from-env");
  });

  test("is undefined with neither set", () => {
    expect(resolveShipToken(undefined, { env: {} })).toBeUndefined();
  });

  test("treats an empty string as unset, from either source", () => {
    expect(resolveShipToken("", { env: { [SHIP_TOKEN_ENV_VAR]: "from-env" } })).toBeUndefined();
    expect(resolveShipToken(undefined, { env: { [SHIP_TOKEN_ENV_VAR]: "" } })).toBeUndefined();
  });

  test("reads process.env when no env is injected", () => {
    process.env[SHIP_TOKEN_ENV_VAR] = "ambient";
    try {
      expect(resolveShipToken(undefined)).toBe("ambient");
    } finally {
      delete process.env[SHIP_TOKEN_ENV_VAR];
    }
  });
});

describe("the ship's armory pull", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const stubBridge = () => {
    const authorizations: (string | null)[] = [];
    const revision = "b".repeat(64);
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        if (new URL(request.url).pathname === "/armory") {
          return Response.json({ revision, entries: [], dotfileMap: {} });
        }
        return new Response("not found", { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    return { authorizations, revision, url: `http://localhost:${server.port}` };
  };

  const isolatedHome = async () => {
    const home = await mkdtemp(join(tmpdir(), "fleet-ship-token-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    cleanups.push(async () => {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await rm(home, { recursive: true, force: true });
    });
    return home;
  };

  const sync = async (config: Record<string, unknown>, bridge: ReturnType<typeof stubBridge>) => {
    await isolatedHome();
    const app = createApp(stubManager(), {
      ...stubConfig,
      bridgeUrl: bridge.url,
      ...config,
    } as never);
    const response = await app.handle(
      new Request("http://ship/armory/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridgeUrl: bridge.url, revision: bridge.revision }),
      }),
    );
    return response;
  };

  test("presents a configured shipToken to the bridge", async () => {
    const bridge = stubBridge();
    const response = await sync({ shipToken: "ship-secret" }, bridge);

    expect(response.status).toBe(200);
    expect(bridge.authorizations).toEqual(["Bearer ship-secret"]);
  });

  test("sends no credential when the ship has no shipToken", async () => {
    const bridge = stubBridge();
    const response = await sync({}, bridge);

    expect(response.status).toBe(200);
    expect(bridge.authorizations).toEqual([null]);
  });
});
