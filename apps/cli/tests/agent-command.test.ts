import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand } from "../src/agent-command";
import { initAgent, updateStatus } from "../src/agent-ship";

const entrypoint = join(import.meta.dir, "..", "src", "index.ts");

async function runFleet(args: string[], cwd?: string) {
  const process = Bun.spawn(["bun", entrypoint, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("fleet agent", () => {
  test("encodes workspace identifiers in ship request path segments", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json({
          state: "idle",
          description: "",
          model: "model",
          provider: "provider",
          harness: "harness",
        });
      },
    });
    const location = {
      baseUrl: `http://localhost:${server.port}`,
      repo: "repo ?#% 雪",
      name: "work ?#% λ",
    };

    try {
      await initAgent(location, { model: "model", provider: "provider", harness: "harness" });
      await updateStatus(location, { state: "idle", description: "" });
      expect(paths).toEqual([
        "/workspaces/repo%20%3F%23%25%20%E9%9B%AA/work%20%3F%23%25%20%CE%BB/agent/init",
        "/workspaces/repo%20%3F%23%25%20%E9%9B%AA/work%20%3F%23%25%20%CE%BB/agent/status",
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("identifies its audience and lists every agent operation", () => {
    const help = agentCommand.helpInformation();

    expect(help).toContain("Workspace reporting commands for agents, not necessarily humans");
    expect(help).toContain("init");
    expect(help).toContain("status");
    expect(help).toContain("in-workspace");
  });

  test("is registered by the fleet executable", async () => {
    const { exitCode, stdout, stderr } = await runFleet(["agent", "--help"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: fleet agent");
    expect(stdout).toContain("Workspace reporting commands for agents, not necessarily humans");
  });

  test("dispatches workspace detection and status reporting through fleet", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        requests.push({ path: new URL(request.url).pathname, body });
        const submittedState = (body as { state?: string }).state;
        return Response.json({
          state: submittedState ?? "idle",
          description: (body as { description?: string }).description ?? "",
          model: "test-model",
          provider: "test-provider",
          harness: "test-harness",
        });
      },
    });
    const dataDirectory = await mkdtemp(join(tmpdir(), "fleet-agent-command-"));
    const workspace = join(dataDirectory, "repo", "worker");
    await mkdir(workspace, { recursive: true });
    await Bun.write(join(dataDirectory, "atlas.json"), JSON.stringify({ port: server.port }));

    try {
      expect(await runFleet(["agent", "in-workspace"], workspace)).toEqual({
        exitCode: 0,
        stdout: "repo/worker\n",
        stderr: "",
      });

      const initialized = await runFleet([
        "agent",
        "init",
        "--model",
        "test-model",
        "--provider",
        "test-provider",
        "--harness",
        "test-harness",
      ], workspace);
      expect(initialized).toEqual({
        exitCode: 0,
        stdout: "agent session started on repo/worker (idle)\n",
        stderr: "",
      });

      const updated = await runFleet([
        "agent",
        "status",
        "building",
        "-d",
        "Implementing the unified Fleet agent command and exercising its HTTP request path.",
      ], workspace);
      expect(updated).toEqual({
        exitCode: 0,
        stdout: "status updated to building on repo/worker\n",
        stderr: "",
      });

      expect(requests).toEqual([
        {
          path: "/workspaces/repo/worker/agent/init",
          body: { model: "test-model", provider: "test-provider", harness: "test-harness" },
        },
        {
          path: "/workspaces/repo/worker/agent/status",
          body: {
            state: "building",
            description: "Implementing the unified Fleet agent command and exercising its HTTP request path.",
          },
        },
      ]);
    } finally {
      server.stop(true);
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
