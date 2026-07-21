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

/** Like `makeApp`, but returns the raw response text — for the text/plain diff route. */
function makeTextApp(overrides: Record<string, unknown> = {}) {
  const app = createApp(stubManager(overrides), stubConfig);
  return async (path: string) => {
    const res = await app.handle(new Request(`http://ship${path}`));
    return { status: res.status, text: await res.text() };
  };
}

describe("ship API", () => {
  test("GET /workspaces parses the active filter", async () => {
    // Stub reflects the filter it received back as the row's repoName.
    const call = makeApp({ list: async (f: unknown) => [{ repoName: String(f), name: "x", branch: "main", active: false }] });
    expect((await call("GET", "/workspaces")).body[0].repoName).toBe("undefined");
    expect((await call("GET", "/workspaces?active=true")).body[0].repoName).toBe("active");
    expect((await call("GET", "/workspaces?active=false")).body[0].repoName).toBe("inactive");
    expect((await call("GET", "/workspaces?active=garbage")).body[0].repoName).toBe("undefined");
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

  test("GET /workspaces/:repo/:name/diff returns raw diff text, maps 404", async () => {
    const ok = await makeTextApp()("/workspaces/r/n/diff");
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("DIFF");

    const missing = makeTextApp({
      diff: async () => {
        throw new WorkspaceError("workspace not found: r/n", 404);
      },
    });
    const res = await missing("/workspaces/r/n/diff");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: "workspace not found: r/n" });
  });

  test("GET /workspaces/:repo/:name/diff coerces query into DiffOptions", async () => {
    // Stub echoes the parsed options back so we can assert the coercion.
    const call = makeTextApp({ diff: async (_r: string, _n: string, opts: unknown) => JSON.stringify(opts) });

    expect(JSON.parse((await call("/workspaces/r/n/diff")).text)).toEqual({});
    expect(
      JSON.parse((await call("/workspaces/r/n/diff?staged=true&nameOnly=true&range=HEAD~1")).text),
    ).toEqual({ staged: true, nameOnly: true, range: "HEAD~1" });
    expect(JSON.parse((await call("/workspaces/r/n/diff?paths=a.ts&paths=b.ts")).text)).toEqual({
      paths: ["a.ts", "b.ts"],
    });
    expect(JSON.parse((await call("/workspaces/r/n/diff?includeUntracked=true")).text)).toEqual({
      includeUntracked: true,
    });
  });

  test("POST /workspaces returns 201, maps 409, validates body (422)", async () => {
    const ok = await makeApp()("POST", "/workspaces", { url: "git@x/r.git", repoName: "r", name: "n", branch: "main" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ repoName: "r", name: "n", active: false });

    const dup = makeApp({
      create: async () => {
        throw new WorkspaceError("workspace already exists: r/n", 409);
      },
    });
    expect(
      (await dup("POST", "/workspaces", { url: "git@x/r.git", repoName: "r", name: "n", branch: "main" })).status,
    ).toBe(409);

    expect((await makeApp()("POST", "/workspaces", { repoName: "r" })).status).toBe(422);
  });

  test("invalid identifiers from the manager are returned as 4xx errors", async () => {
    const manager = new (await import("../src/workspace-manager")).WorkspaceManager(stubConfig);
    const app = createApp(manager, stubConfig);
    const create = await app.handle(
      new Request("http://ship/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "url", repoName: "bad\\repo", name: "ws", branch: "main" }),
      }),
    );
    expect(create.status).toBe(400);
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

  test("POST /agent/init echoes an idle AgentStatus, validates body, maps errors", async () => {
    const ok = await makeApp()("POST", "/workspaces/r/n/agent/init", {
      model: "opus",
      provider: "anthropic",
      harness: "claude-code",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: "idle", model: "opus", provider: "anthropic", harness: "claude-code" });

    // Missing body fields → 422 from Elysia's schema validation.
    expect((await makeApp()("POST", "/workspaces/r/n/agent/init", { model: "opus" })).status).toBe(422);

    const inactive = makeApp({
      initAgent: async () => {
        throw new WorkspaceError("workspace not active: r/n", 400);
      },
    });
    expect(
      (await inactive("POST", "/workspaces/r/n/agent/init", { model: "opus", provider: "anthropic", harness: "cc" }))
        .status,
    ).toBe(400);
  });

  test("GET /agent/status returns the current status (null by default)", async () => {
    expect((await makeApp()("GET", "/workspaces/r/n/agent/status")).body).toBeUndefined();

    const call = makeApp({
      agentStatus: () => ({
        state: "building",
        description: "Created session at t",
        model: "opus",
        provider: "anthropic",
        harness: "cc",
      }),
    });
    const res = await call("GET", "/workspaces/r/n/agent/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "building", model: "opus" });
  });

  test("POST /agent/status updates state+description, rejects bad state (422), maps errors", async () => {
    const ok = await makeApp()("POST", "/workspaces/r/n/agent/status", {
      state: "building",
      description: "writing the parser",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: "building", description: "writing the parser" });

    // A state outside the allowed union → 422.
    expect((await makeApp()("POST", "/workspaces/r/n/agent/status", { state: "napping", description: "z" })).status).toBe(
      422,
    );

    const uninitialized = makeApp({
      updateAgentStatus: async () => {
        throw new WorkspaceError("agent not initialized: r/n", 400);
      },
    });
    expect(
      (await uninitialized("POST", "/workspaces/r/n/agent/status", { state: "idle", description: "d" })).status,
    ).toBe(400);
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
});
