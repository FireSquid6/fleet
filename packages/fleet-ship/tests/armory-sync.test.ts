// The bridge is a stub `fetch` serving an empty manifest: what is under test is
// the ordering of pull-then-install, not the pull (see armory-cache.test.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArmoryCache } from "../src/armory/armory-cache";
import type { ArmoryInstallReport } from "../src/armory/armory-installer";
import { syncAndInstall } from "../src/armory/armory-sync";

describe("syncAndInstall", () => {
  const dirs: string[] = [];
  const revision = "a".repeat(64);

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const cacheFor = async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "fleet-armory-sync-"));
    dirs.push(homeDirectory);
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/armory")
        ? Response.json({ revision, entries: [], dotfileMap: {} })
        : new Response("no such file", { status: 404 })) as typeof fetch;
    return new ArmoryCache({ homeDirectory, fetch: fetchImpl });
  };

  const request = { bridgeUrl: "http://bridge.test", revision };

  test("records what the install applied", async () => {
    const cache = await cacheFor();
    const report: ArmoryInstallReport = {
      skills: [{ skill: "demo", provider: "claude-code", path: "/home/x", status: "installed" }],
      plugins: [],
      dotfiles: [
        { source: ".tmux.conf", target: "/home/.tmux.conf", status: "linked" },
        { source: "nvim", target: "/home/.config/nvim", status: "conflict" },
      ],
      removed: ["/home/y"],
      conflicts: ["/home/z"],
      warnings: ["careful"],
    };

    const state = await syncAndInstall(cache, request, { install: async () => report });

    expect(state).toMatchObject({ revision, lastError: null });
    expect(state.install).toMatchObject({
      skillCount: 1,
      pluginCount: 0,
      // The conflicted mapping is not a link in place.
      dotfileCount: 1,
      removedCount: 1,
      conflicts: ["/home/z"],
      warnings: ["careful"],
    });
    expect((await cache.state()).install?.installedAt).toBe(state.install!.installedAt);
  });

  test("a failed install is reported without discarding the successful pull", async () => {
    const cache = await cacheFor();

    await expect(
      syncAndInstall(cache, request, {
        install: async () => {
          throw new AggregateError([new Error("permission denied: /home/x")], "nope");
        },
      }),
    ).rejects.toMatchObject({ status: 500 });

    const state = await cache.state();
    expect(state.revision).toBe(revision);
    expect(state.lastError).toContain("permission denied: /home/x");
  });
});
