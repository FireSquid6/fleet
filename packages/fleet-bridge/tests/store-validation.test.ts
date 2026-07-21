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
});
