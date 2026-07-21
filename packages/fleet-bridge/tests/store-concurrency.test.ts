import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoAlreadyExistsError, Store } from "../src/store/store";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}

describe("Store concurrency and persistence", () => {
  const directories: string[] = [];

  async function directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    directories.push(path);
    return path;
  }

  afterEach(async () => {
    for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  });

  test("serializes concurrent same-name and different-name repo creation", async () => {
    const entered = deferred();
    const release = deferred();
    const writes: string[] = [];
    const store = new Store(await directory(), {
      persist: async (_target, contents) => {
        writes.push(contents);
        if (writes.length === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    await store.load();

    const first = store.createRepo({ name: "same", url: "first", provider: "custom" });
    await entered.promise;
    const duplicate = store.createRepo({ name: "same", url: "duplicate", provider: "custom" });
    const duplicateResult = duplicate.then(
      () => undefined,
      (error) => error,
    );
    const different = store.createRepo({ name: "other", url: "other", provider: "custom" });
    await Bun.sleep(5);
    expect(writes).toHaveLength(1);
    release.resolve();

    await expect(first).resolves.toMatchObject({ name: "same" });
    expect(await duplicateResult).toBeInstanceOf(RepoAlreadyExistsError);
    await expect(different).resolves.toMatchObject({ name: "other" });
    expect(writes).toHaveLength(2);
    expect((await store.getAllRepos()).map((repo) => repo.name).sort()).toEqual(["other", "same"]);
  });

  test("serializes overlapping repo and ship mutations through one queue", async () => {
    const entered = deferred();
    const release = deferred();
    const targets: string[] = [];
    const store = new Store(await directory(), {
      persist: async (target) => {
        targets.push(target);
        if (targets.length === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    await store.load();

    const repo = store.createRepo({ name: "repo", url: "url", provider: "custom" });
    await entered.promise;
    const ship = store.createShip({ name: "ship", url: "http://ship" });
    await Bun.sleep(5);
    expect(targets).toHaveLength(1);
    release.resolve();
    await Promise.all([repo, ship]);

    expect(targets.map((target) => target.slice(target.lastIndexOf("/") + 1))).toEqual([
      "repos.json",
      "ships.json",
    ]);
  });

  test("atomically persists concurrent mutations for restart readback", async () => {
    const path = await directory();
    const store = new Store(path);
    await store.load();
    await Promise.all([
      store.createRepo({ name: "repo-a", url: "a", provider: "custom" }),
      store.createRepo({ name: "repo-b", url: "b", provider: "github" }),
      store.createShip({ name: "ship-a", url: "http://a" }),
      store.createShip({ name: "ship-b", url: "http://b" }),
    ]);

    const restarted = new Store(path);
    await restarted.load();
    expect((await restarted.getAllRepos()).map((repo) => repo.name)).toEqual(["repo-a", "repo-b"]);
    expect((await restarted.getAllShips()).map((ship) => ship.name)).toEqual(["ship-a", "ship-b"]);
    expect((await readdir(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("recovers after a failed atomic write without publishing memory state", async () => {
    const path = await directory();
    await mkdir(join(path, "repos.json"));
    const store = new Store(path);
    await expect(store.createRepo({ name: "repo", url: "failed", provider: "custom" })).rejects.toThrow(
      /non-file/,
    );
    expect(await store.getAllRepos()).toEqual([]);

    await rm(join(path, "repos.json"), { recursive: true });
    await store.createRepo({ name: "repo", url: "recovered", provider: "custom" });
    const restarted = new Store(path);
    await restarted.load();
    expect(await restarted.getAllRepos()).toEqual([{ name: "repo", url: "recovered", provider: "custom" }]);
    expect((await readdir(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses to read or replace symlinked store files", async () => {
    const path = await directory();
    const outside = join(await directory(), "outside.json");
    await Bun.write(outside, "[]");
    await symlink(outside, join(path, "repos.json"));

    await expect(new Store(path).load()).rejects.toThrow(/non-file/);
    const store = new Store(path);
    await expect(store.createRepo({ name: "repo", url: "url", provider: "custom" })).rejects.toThrow(
      /non-file/,
    );
    expect(await Bun.file(outside).text()).toBe("[]");
  });
});
