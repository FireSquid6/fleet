/**
 * repo-branches.test.ts — `GET /repos/:name/branches` driven in-process against
 * a fake `Git.lsRemote`, so the route/manager mapping is exercised without a git
 * binary or a reachable remote.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, type RemoteRef } from "git-bun";
import { FleetManager } from "../src/fleet-manager";
import { createApp } from "../src/api";
import { Store } from "../src/store/store";
import { makeDeps, makeTestAuth } from "./helpers";

/** What the fake `lsRemote` was asked, and what it answers with. */
interface LsRemoteStub {
  calls: { url: string; cwd: string; heads?: boolean; env?: Record<string, string> }[];
  answer: () => RemoteRef[] | Promise<RemoteRef[]>;
}

describe("GET /repos/:name/branches", () => {
  let dir: string;
  let manager: FleetManager;
  let app: ReturnType<typeof createApp>;
  let lsRemote: LsRemoteStub;

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.handle(
      new Request(`http://bridge${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-bridge-branches-"));
    lsRemote = {
      calls: [],
      answer: () => [
        { sha: "sha-main", ref: "refs/heads/main" },
        { sha: "sha-feature", ref: "refs/heads/feature/login" },
        { sha: "sha-alpha", ref: "refs/heads/alpha" },
      ],
    };
    const config = { dataDirectory: dir, port: 4901, name: "bridge" };
    const store = new Store(dir);
    await store.load();
    manager = new FleetManager(config, makeDeps(new Map()), {
      syncTimeoutMs: 50,
      store,
      lsRemoteTimeoutMs: 50,
      lsRemote: async (url, options) => {
        lsRemote.calls.push({ url, cwd: options.cwd, heads: options.heads, env: options.env });
        return lsRemote.answer();
      },
    });
    await manager.init();
    app = createApp(manager, makeTestAuth());
    expect((await call("POST", "/repos", { name: "repo1", url: "git@fake/repo1.git" })).status).toBe(201);
  });
  afterEach(async () => {
    manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  test("maps refs/heads/* to {name, sha}, sorted ascending", async () => {
    const res = await call("GET", "/repos/repo1/branches");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: "alpha", sha: "sha-alpha" },
      { name: "feature/login", sha: "sha-feature" },
      { name: "main", sha: "sha-main" },
    ]);
  });

  test("probes the repo's url from the bridge's data directory, branches only", async () => {
    await call("GET", "/repos/repo1/branches");

    expect(lsRemote.calls).toHaveLength(1);
    expect(lsRemote.calls[0]).toMatchObject({ url: "git@fake/repo1.git", cwd: dir, heads: true });
  });

  test("runs git non-interactively and under its own deadlines", async () => {
    await call("GET", "/repos/repo1/branches");

    // Without the first three git opens /dev/tty for the prompt — the bridge runs
    // in an operator's terminal, so the request would block until someone typed.
    // The last two make git abandon a stalled transfer itself, which is the only
    // thing that reaps the process: giving up on the promise does not.
    expect(lsRemote.calls[0]!.env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10",
      GIT_HTTP_LOW_SPEED_LIMIT: "1",
      GIT_HTTP_LOW_SPEED_TIME: "15",
    });
  });

  test("a probe that never settles is abandoned as a 502 instead of hanging", async () => {
    lsRemote.answer = () => new Promise<RemoteRef[]>(() => {});

    const res = await call("GET", "/repos/repo1/branches");

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("timed out");
    expect(res.body.error).toContain("repo1");
  });

  test("drops refs that are not branches", async () => {
    lsRemote.answer = () => [
      { sha: "sha-main", ref: "refs/heads/main" },
      { sha: "sha-tag", ref: "refs/tags/v1.0.0" },
      { sha: "sha-pull", ref: "refs/pull/7/head" },
      { sha: "sha-head", ref: "HEAD" },
    ];

    const res = await call("GET", "/repos/repo1/branches");

    expect(res.body).toEqual([{ name: "main", sha: "sha-main" }]);
  });

  test("an unregistered repo returns 404", async () => {
    expect((await call("GET", "/repos/ghost/branches")).status).toBe(404);
    expect(lsRemote.calls).toHaveLength(0);
  });

  test("an invalid repo identifier returns 400", async () => {
    expect((await call("GET", "/repos/..%2Fescape/branches")).status).toBe(400);
  });

  test("a token embedded in the repo url never reaches the error response", async () => {
    const url = "https://x-access-token:ghp_SECRET@github.com/acme/private.git";
    expect((await call("POST", "/repos", { name: "private", url })).status).toBe(201);
    lsRemote.answer = () => {
      // git replays the command line — token and all — in the GitError message,
      // and redacts it only in its own stderr.
      throw new GitError(["ls-remote", "--heads", "--", url], {
        stdout: "",
        stderr: "fatal: Authentication failed for 'https://github.com/acme/private.git/'",
        exitCode: 128,
      });
    };

    const res = await call("GET", "/repos/private/branches");

    expect(res.status).toBe(502);
    expect(res.body.error).not.toContain("ghp_SECRET");
    expect(res.body.error).toContain("Authentication failed");
  });

  test("a password containing @ is redacted whole, not up to its first @", async () => {
    lsRemote.answer = () => {
      throw new GitError(["ls-remote"], {
        stdout: "",
        stderr: "fatal: could not read from 'https://user:p@ssw0rd@github.com/o/r.git'",
        exitCode: 128,
      });
    };

    const res = await call("GET", "/repos/repo1/branches");

    expect(res.body.error).not.toContain("ssw0rd");
    expect(res.body.error).toContain("https://***@github.com/o/r.git");
  });

  test("credentials git echoes back in its own stderr are redacted too", async () => {
    lsRemote.answer = () => {
      throw new GitError(["ls-remote"], {
        stdout: "",
        stderr: "fatal: could not read from 'https://user:ghp_SECRET@github.com/acme/private.git'",
        exitCode: 128,
      });
    };

    const res = await call("GET", "/repos/repo1/branches");

    expect(res.body.error).not.toContain("ghp_SECRET");
    expect(res.body.error).toContain("https://***@github.com/acme/private.git");
  });

  test("an unreachable remote surfaces as 502 naming the repo", async () => {
    lsRemote.answer = () => {
      throw new GitError(["ls-remote", "--heads", "--", "git@fake/repo1.git"], {
        stdout: "",
        stderr: "fatal: repository not found",
        exitCode: 128,
      });
    };

    const res = await call("GET", "/repos/repo1/branches");

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("repo1");
    expect(res.body.error).toContain("repository not found");
  });
});
