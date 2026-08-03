import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entrypoint = join(import.meta.dir, "..", "src", "index.ts");

interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

const repoInfo = {
  name: "acme",
  fullName: "acme/acme",
  description: "the acme repo",
  url: "https://github.com/acme/acme",
  defaultBranch: "main",
  private: false,
  stars: 42,
  openIssues: 3,
};

const issueSummary = {
  number: 7,
  title: "widgets are broken",
  state: "open",
  author: "wile",
  url: "https://github.com/acme/acme/issues/7",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

const issue = { ...issueSummary, body: "steps to reproduce", comments: 2 };

const prSummary = {
  number: 3,
  title: "fix the widgets",
  state: "open",
  author: "roadrunner",
  url: "https://github.com/acme/acme/pull/3",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  draft: false,
  baseBranch: "main",
  headBranch: "fix-widgets",
};

const pullRequest = {
  ...prSummary,
  body: "this fixes them",
  merged: false,
  mergeable: true,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
};

const issueComment = {
  id: 100,
  author: "wile",
  body: "hello",
  url: "https://github.com/acme/acme/issues/7#comment-100",
  createdAt: "2026-01-03T00:00:00Z",
};

const review = {
  id: 200,
  state: "APPROVED",
  author: "roadrunner",
  body: "",
  url: "https://github.com/acme/acme/pull/3#review-200",
};

const checkRun = {
  name: "build",
  status: "completed",
  conclusion: "failure",
  detailsUrl: "https://github.com/acme/acme/runs/1",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:05:00Z",
};

const failedLog = { workflow: "CI", job: "test", jobId: 901, log: "boom: the test failed" };

function makeFakeBridge(overrides?: (path: string) => Response | undefined) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      let body: unknown = null;
      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch {
          body = null;
        }
      }
      requests.push({ method: request.method, path, query: url.search, body });

      const override = overrides?.(path);
      if (override) return override;

      if (path.endsWith("/checks/logs")) return Response.json([failedLog]);
      if (path.endsWith("/checks")) return Response.json([checkRun]);
      if (path.endsWith("/info")) return Response.json(repoInfo);
      if (path.endsWith("/issues")) return Response.json([issueSummary]);
      if (path.endsWith("/issues/7")) return Response.json(issue);
      if (path.endsWith("/issues/7/comments")) return Response.json(issueComment);
      if (path.endsWith("/pulls")) return Response.json([prSummary]);
      if (path.endsWith("/pulls/3")) return Response.json(pullRequest);
      if (path.endsWith("/pulls/3/comments")) return Response.json(issueComment);
      if (path.endsWith("/pulls/3/reviews")) return Response.json(review);
      return Response.json({ error: "unexpected route" }, { status: 404 });
    },
  });
  return { server, requests };
}

async function runFagent(args: string[], cwd?: string) {
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

describe("fagent repo", () => {
  test("lists its subcommands in --help", async () => {
    const { exitCode, stdout } = await runFagent(["repo", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("info");
    expect(stdout).toContain("issue");
    expect(stdout).toContain("pr");
    expect(stdout).toContain("review");
  });

  test("info hits GET /repos/:name/info and prints the formatted info", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stdout, stderr } = await runFagent(["repo", "info", "--repo", "acme", "--bridge-url", url]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("acme/acme");
      expect(stdout).toContain("the acme repo");
      expect(stdout).toContain("openIssues");
      expect(requests).toEqual([{ method: "GET", path: "/repos/acme/info", query: "", body: null }]);
    } finally {
      server.stop(true);
    }
  });

  test("issue list hits /issues and forwards -s as ?state=", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const listed = await runFagent(["repo", "issue", "list", "--repo", "acme", "--bridge-url", url]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("widgets are broken");

      const closed = await runFagent(["repo", "issue", "list", "-s", "closed", "--repo", "acme", "--bridge-url", url]);
      expect(closed.exitCode).toBe(0);

      expect(requests[0]!.path).toBe("/repos/acme/issues");
      expect(requests[1]!.path).toBe("/repos/acme/issues");
      expect(requests[1]!.query).toBe("?state=closed");
    } finally {
      server.stop(true);
    }
  });

  test("issue view hits /issues/:number", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stdout } = await runFagent(["repo", "issue", "view", "7", "--repo", "acme", "--bridge-url", url]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("#7 widgets are broken");
      expect(stdout).toContain("steps to reproduce");
      expect(requests[0]!.path).toBe("/repos/acme/issues/7");
    } finally {
      server.stop(true);
    }
  });

  test("issue comment POSTs { body } to /issues/:number/comments", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stdout } = await runFagent(["repo", "issue", "comment", "7", "hello", "--repo", "acme", "--bridge-url", url]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("commented on issue #7:");
      expect(requests[0]!.method).toBe("POST");
      expect(requests[0]!.path).toBe("/repos/acme/issues/7/comments");
      expect(requests[0]!.body).toEqual({ body: "hello" });
    } finally {
      server.stop(true);
    }
  });

  test("pr view hits /pulls/:number", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stdout } = await runFagent(["repo", "pr", "view", "3", "--repo", "acme", "--bridge-url", url]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("#3 fix the widgets");
      expect(stdout).toContain("+10 -2 (1 files)");
      expect(requests[0]!.path).toBe("/repos/acme/pulls/3");
    } finally {
      server.stop(true);
    }
  });

  test("review --approve POSTs { event: APPROVE } to /pulls/:number/reviews", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stdout } = await runFagent(["repo", "review", "3", "--approve", "--repo", "acme", "--bridge-url", url]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("submitted APPROVE review on pr #3:");
      expect(requests[0]!.method).toBe("POST");
      expect(requests[0]!.path).toBe("/repos/acme/pulls/3/reviews");
      expect(requests[0]!.body).toMatchObject({ event: "APPROVE" });
    } finally {
      server.stop(true);
    }
  });

  test("review with no event flag exits non-zero with a clear message", async () => {
    const { server } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stderr } = await runFagent(["repo", "review", "3", "--repo", "acme", "--bridge-url", url]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("fagent: choose exactly one of --approve, --request-changes, --comment");
    } finally {
      server.stop(true);
    }
  });

  test("auto-detects the repo from the workspace path when --repo is omitted", async () => {
    const { server, requests } = makeFakeBridge();
    const dataDirectory = await mkdtemp(join(tmpdir(), "fleet-repo-command-"));
    const workspace = join(dataDirectory, "acme", "work");
    await mkdir(workspace, { recursive: true });
    await Bun.write(join(dataDirectory, "atlas.json"), JSON.stringify({ port: server.port }));

    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode } = await runFagent(["repo", "info", "--bridge-url", url], workspace);
      expect(exitCode).toBe(0);
      expect(requests[0]!.path).toBe("/repos/acme/info");
    } finally {
      server.stop(true);
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  test("checks --ref hits GET /repos/:name/checks?ref= and prints the check table", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stdout, stderr } = await runFagent(["repo", "checks", "--ref", "main", "--repo", "acme", "--bridge-url", url]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("build");
      expect(stdout).toContain("failure");
      expect(requests[0]!.path).toBe("/repos/acme/checks");
      expect(requests[0]!.query).toBe("?ref=main");
    } finally {
      server.stop(true);
    }
  });

  test("logs --pr hits GET /repos/:name/checks/logs?pr= and prints the job header + log", async () => {
    const { server, requests } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stdout } = await runFagent(["repo", "logs", "--pr", "3", "--repo", "acme", "--bridge-url", url]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("=== CI / test (job 901) ===");
      expect(stdout).toContain("boom: the test failed");
      expect(requests[0]!.path).toBe("/repos/acme/checks/logs");
      expect(requests[0]!.query).toBe("?pr=3");
    } finally {
      server.stop(true);
    }
  });

  test("checks defaults to the current git branch when neither --pr nor --ref is given", async () => {
    const { server, requests } = makeFakeBridge();
    const repoDir = await mkdtemp(join(tmpdir(), "fleet-repo-branch-"));
    await Bun.spawn(["git", "init", "-b", "work", "-q"], { cwd: repoDir }).exited;
    await Bun.spawn(
      ["git", "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repoDir },
    ).exited;
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stderr } = await runFagent(
        ["repo", "checks", "--repo", "acme", "--bridge-url", url],
        repoDir,
      );
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(requests[0]!.path).toBe("/repos/acme/checks");
      expect(requests[0]!.query).toBe("?ref=work");
    } finally {
      server.stop(true);
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("checks with both --pr and --ref exits non-zero with the choose-at-most-one message", async () => {
    const { server } = makeFakeBridge();
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stderr } = await runFagent(["repo", "checks", "--pr", "3", "--ref", "main", "--repo", "acme", "--bridge-url", url]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("fagent: choose at most one of --pr, --ref");
    } finally {
      server.stop(true);
    }
  });

  test("prints a request-failed error and exits 1 on a non-2xx response", async () => {
    const { server } = makeFakeBridge((path) =>
      path.endsWith("/info") ? Response.json({ error: "repo not found: x" }, { status: 404 }) : undefined,
    );
    try {
      const url = `http://localhost:${server.port}`;
      const { exitCode, stderr } = await runFagent(["repo", "info", "--repo", "x", "--bridge-url", url]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("fagent: request failed (404): repo not found: x");
    } finally {
      server.stop(true);
    }
  });
});
