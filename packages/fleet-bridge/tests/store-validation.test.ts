import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store";

describe("Store validation", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  test("rejects invalid persisted repo identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(directory);
    await Bun.write(
      join(directory, "repos.json"),
      JSON.stringify([{ name: "../repo", url: "url", provider: "custom" }]),
    );

    await expect(new Store(directory).load()).rejects.toThrow();
  });

  test("rejects invalid persisted and mutated ship identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(directory);
    await Bun.write(join(directory, "ships.json"), JSON.stringify([{ name: "bad/ship", url: "url" }]));
    await expect(new Store(directory).load()).rejects.toThrow();

    const emptyDirectory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(emptyDirectory);
    const store = new Store(emptyDirectory);
    await store.load();
    await expect(store.createShip({ name: "..", url: "url" })).rejects.toThrow();
    await expect(store.replaceAllShips([{ name: "bad\\ship", url: "url" }])).rejects.toThrow();
  });

  test("updateShip preserves the lookup identity against runtime name injection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(directory);
    const store = new Store(directory);
    await store.load();
    await store.createShip({ name: "ship", url: "old" });

    const updated = await store.updateShip("ship", { name: "injected", url: "new" } as never);
    expect(updated).toEqual({ name: "ship", url: "new" });
    expect(await store.getShip("ship")).toEqual(updated);
    expect(await store.getShip("injected")).toBeUndefined();
  });

  test("updateRepo validates lookup and merged data without allowing name injection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(directory);
    const store = new Store(directory);
    await store.load();
    await store.createRepo({ name: "repo", url: "old", provider: "custom" });

    await expect(store.updateRepo("../repo", { url: "new" })).rejects.toThrow();
    await expect(store.updateRepo("repo", { url: 42 } as never)).rejects.toThrow();
    const updated = await store.updateRepo("repo", { name: "injected", url: "new" } as never);
    expect(updated).toEqual({ name: "repo", url: "new", provider: "custom" });
    expect(await store.getRepo("repo")).toEqual(updated);
    expect(await store.getRepo("injected")).toBeUndefined();
  });

  const record = {
    repoName: "repo",
    name: "ws",
    ship: "ship",
    issueNumber: 37,
    branch: "37-add-ephemeral-workspaces",
    cleanup: "watching" as const,
    blockedReason: null,
    blockedAt: null,
    pullRequest: null,
  };

  test("ephemeral records round-trip through a reload, keyed by repo and workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(directory);
    const store = new Store(directory);
    await store.load();

    await store.createEphemeral(record);
    await store.createEphemeral({ ...record, repoName: "other", issueNumber: 12 });
    expect(await store.getEphemeral("repo", "ws")).toEqual(record);

    const reloaded = new Store(directory);
    await reloaded.load();
    expect(await reloaded.getAllEphemeral()).toHaveLength(2);
    expect(await reloaded.getEphemeral("other", "ws")).toMatchObject({ issueNumber: 12 });

    expect(await reloaded.deleteEphemeral("repo", "ws")).toEqual(record);
    expect(await reloaded.getEphemeral("repo", "ws")).toBeUndefined();
    expect(await reloaded.deleteEphemeral("repo", "ws")).toBeUndefined();
  });

  test("updateEphemeral merges without moving the record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(directory);
    const store = new Store(directory);
    await store.load();
    await store.createEphemeral(record);

    const updated = await store.updateEphemeral("repo", "ws", {
      repoName: "injected",
      name: "injected",
      cleanup: "blocked",
      blockedReason: "a stash",
      blockedAt: "2026-08-03T00:00:00.000Z",
    } as never);
    expect(updated).toMatchObject({ repoName: "repo", name: "ws", cleanup: "blocked", blockedReason: "a stash" });
    expect(await store.getEphemeral("injected", "injected")).toBeUndefined();
    expect(await store.updateEphemeral("repo", "gone", { cleanup: "blocked" })).toBeUndefined();
  });

  test("rejects ephemeral records that are invalid on disk or at the boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(directory);
    await Bun.write(join(directory, "ephemeral.json"), JSON.stringify([{ ...record, repoName: "../repo" }]));
    await expect(new Store(directory).load()).rejects.toThrow();

    const clean = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(clean);
    const store = new Store(clean);
    await store.load();
    await expect(store.createEphemeral({ ...record, issueNumber: 0 })).rejects.toThrow();
    await expect(store.createEphemeral({ ...record, blockedReason: "x".repeat(201) })).rejects.toThrow();
    await expect(store.getEphemeral("bad/repo", "ws")).rejects.toThrow();
  });
});
