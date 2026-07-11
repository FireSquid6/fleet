/**
 * api.test.ts — drives the ship's composed Elysia app in-process via
 * `app.handle(Request)` over a stub WorkspaceManager (no tmux/git). Asserts route
 * wiring, the `active` query parsing, status codes, and the `WorkspaceError → status`
 * mapping from `api/http.ts`.
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api";
import { WorkspaceError } from "../src/workspace-manager";
import { stubConfig, stubManager } from "./helpers";

function makeApp(overrides: Record<string, unknown> = {}) {
  const app = createApp(stubManager(overrides), stubConfig);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://ship${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

describe("ship API", () => {
  test("GET /workspaces parses the active filter", async () => {
    // Stub reflects the filter it received back as the row's repo.
    const call = makeApp({ list: async (f: unknown) => [{ repo: String(f), name: "x", branch: "main", active: false }] });
    expect((await call("GET", "/workspaces")).body[0].repo).toBe("undefined");
    expect((await call("GET", "/workspaces?active=true")).body[0].repo).toBe("active");
    expect((await call("GET", "/workspaces?active=false")).body[0].repo).toBe("inactive");
    expect((await call("GET", "/workspaces?active=garbage")).body[0].repo).toBe("undefined");
  });

  test("GET /workspaces/:repo/:name returns status, maps 404", async () => {
    expect((await makeApp()("GET", "/workspaces/r/n")).body).toMatchObject({ state: "inactive" });

    const call = makeApp({
      get: async () => {
        throw new WorkspaceError("workspace not found: r/n", 404);
      },
    });
    const res = await call("GET", "/workspaces/r/n");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "workspace not found: r/n" });
  });

  test("POST /workspaces returns 201, maps 409, validates body (422)", async () => {
    const ok = await makeApp()("POST", "/workspaces", { repo: "r", name: "n", branch: "main" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ repo: "r", name: "n", active: false });

    const dup = makeApp({
      create: async () => {
        throw new WorkspaceError("workspace already exists: r/n", 409);
      },
    });
    expect((await dup("POST", "/workspaces", { repo: "r", name: "n", branch: "main" })).status).toBe(409);

    expect((await makeApp()("POST", "/workspaces", { repo: "r" })).status).toBe(422);
  });

  test("verb routes return { ok: true } and map errors", async () => {
    const call = makeApp();
    expect(await call("POST", "/workspaces/r/n/activate")).toEqual({ status: 200, body: { ok: true } });
    expect(await call("POST", "/workspaces/r/n/deactivate")).toEqual({ status: 200, body: { ok: true } });
    expect(await call("POST", "/workspaces/r/n/branch", { branch: "dev" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await call("DELETE", "/workspaces/r/n")).toEqual({ status: 200, body: { ok: true } });

    const badActivate = makeApp({
      activate: async () => {
        throw new WorkspaceError("workspace already active: r/n", 400);
      },
    });
    expect((await badActivate("POST", "/workspaces/r/n/activate")).status).toBe(400);
  });

  test("a non-WorkspaceError maps to 500", async () => {
    const call = makeApp({
      get: async () => {
        throw new Error("kaboom");
      },
    });
    const res = await call("GET", "/workspaces/r/n");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "kaboom" });
  });

  test("GET /system-resources returns a live snapshot shape", async () => {
    const res = await makeApp()("GET", "/system-resources");
    expect(res.status).toBe(200);
    expect(res.body.cpu.cores).toBeGreaterThan(0);
    expect(res.body.memory.total).toBeGreaterThan(0);
    expect(res.body.os.hostname.length).toBeGreaterThan(0);
  });

  test("GET /repos returns the manager's repo list", async () => {
    const call = makeApp({
      listRepos: async () => [{ repo: "sysdef", remote: "git@x/sysdef.git", workspaces: 2 }],
    });
    const res = await call("GET", "/repos");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ repo: "sysdef", remote: "git@x/sysdef.git", workspaces: 2 }]);
  });
});
