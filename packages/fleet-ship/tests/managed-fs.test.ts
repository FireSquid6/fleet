import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  inspectManagedFile,
  MANAGED_ARTIFACT_MAX_AGE_MS,
  managedFilesManifestPath,
  managedFilesLockDatabasePath,
  withManagedFiles,
} from "../src/managed-fs";
import { installFleetPlugin } from "../src/plugin-installer";
import { installFleetSkill } from "../src/skill-installer";

describe("managed files", () => {
  const homes: string[] = [];

  async function fixture(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "fleet-managed-"));
    homes.push(home);
    await mkdir(join(home, ".claude"));
    return home;
  }

  async function sync(
    home: string,
    destination: string,
    contents: string,
    force = false,
  ) {
    return withManagedFiles(home, (session) =>
      session.sync(destination, contents, { provider: "claude-code", kind: "skill", force }),
    );
  }

  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });

  test("installs, updates owned content, preserves edits, and force reclaims them", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "skill.md");

    expect(await sync(home, destination, "one")).toBe("installed");
    expect(await sync(home, destination, "one")).toBe("unchanged");
    expect(await sync(home, destination, "two")).toBe("updated");
    expect(await inspectManagedFile(home, destination, "three")).toBe("outdated-owned");

    await Bun.write(destination, "user edit");
    expect(await sync(home, destination, "three")).toBe("conflict");
    expect(await Bun.file(destination).text()).toBe("user edit");
    expect(await inspectManagedFile(home, destination, "three")).toBe("conflict-unmanaged");

    expect(await sync(home, destination, "three", true)).toBe("updated");
    expect(await Bun.file(destination).text()).toBe("three");
  });

  test("adopts an exact pre-manifest file without rewriting it", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "skill.md");
    await Bun.write(destination, "exact");
    const inode = (await lstat(destination)).ino;

    expect(await sync(home, destination, "exact")).toBe("adopted");
    expect((await lstat(destination)).ino).toBe(inode);
    const manifest = await Bun.file(managedFilesManifestPath(home)).json();
    expect(manifest.version).toBe(1);
    expect(manifest.files[destination]).toMatchObject({
      provider: "claude-code",
      kind: "skill",
    });
  });

  test("recovers a completed file write when the manifest is missing", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "skill.md");
    expect(await sync(home, destination, "exact")).toBe("installed");
    const inode = (await lstat(destination)).ino;
    await unlink(managedFilesManifestPath(home));

    expect(await sync(home, destination, "exact")).toBe("adopted");
    expect((await lstat(destination)).ino).toBe(inode);
    expect(await Bun.file(managedFilesManifestPath(home)).exists()).toBe(true);
  });

  test("reads version 1 manifests written before modes and transitions were added", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "skill.md");
    await sync(home, destination, "exact");
    const path = managedFilesManifestPath(home);
    const manifest = await Bun.file(path).json();
    delete manifest.transitions;
    delete manifest.files[destination].mode;
    await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(await sync(home, destination, "exact")).toBe("unchanged");
  });

  test("refuses symlinks, non-files, and symlinked parents even with force", async () => {
    const home = await fixture();
    const target = join(home, "target");
    await Bun.write(target, "user");
    const linkedFile = join(home, ".claude", "linked.md");
    await symlink(target, linkedFile);
    await expect(sync(home, linkedFile, "fleet", true)).rejects.toThrow("non-file path");
    expect(await Bun.file(target).text()).toBe("user");

    const directory = join(home, ".claude", "directory");
    await mkdir(directory);
    await expect(sync(home, directory, "fleet", true)).rejects.toThrow("non-file path");

    const outside = join(home, "outside");
    await mkdir(outside);
    const linkedParent = join(home, ".claude", "linked-parent");
    await symlink(outside, linkedParent);
    await expect(sync(home, join(linkedParent, "file"), "fleet", true)).rejects.toThrow(
      "non-directory path",
    );
  });

  test("serializes concurrent manifest updates without losing entries", async () => {
    const home = await fixture();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        sync(home, join(home, ".claude", `file-${index}`), `contents-${index}`),
      ),
    );

    const manifest = await Bun.file(managedFilesManifestPath(home)).json();
    expect(Object.keys(manifest.files)).toHaveLength(12);
  });

  test("serializes concurrent skill and plugin installer calls", async () => {
    const home = await fixture();
    const pluginsDirectory = await mkdtemp(join(tmpdir(), "fleet-managed-plugins-"));
    homes.push(pluginsDirectory);
    const skillSource = join(home, "skill-source.md");
    await Bun.write(skillSource, "skill");
    await Bun.write(join(pluginsDirectory, "opencode.js"), "plugin");
    await mkdir(join(home, ".config", "opencode"), { recursive: true });

    await Promise.all([
      installFleetSkill({
        homeDirectory: home,
        sourcePath: skillSource,
        providers: ["opencode"],
      }),
      installFleetPlugin({ homeDirectory: home, pluginsDirectory, providers: ["opencode"] }),
    ]);

    const manifest = await Bun.file(managedFilesManifestPath(home)).json();
    expect(
      Object.values(manifest.files as Record<string, { kind: string }>)
        .map((value) => value.kind)
        .sort(),
    ).toEqual(["plugin", "skill"]);
  });

  test("does not replace a malformed manifest and ignores abandoned temp files", async () => {
    const home = await fixture();
    const manifest = managedFilesManifestPath(home);
    await mkdir(join(manifest, ".."), { recursive: true });
    await Bun.write(manifest, "not json");
    await Bun.write(join(manifest, "..", ".managed-files-v1.json.fleet-abandoned.tmp"), "partial");

    await expect(sync(home, join(home, ".claude", "skill.md"), "fleet")).rejects.toThrow(
      "manifest is invalid",
    );
    expect(await Bun.file(manifest).text()).toBe("not json");
  });

  for (const field of ["files", "transitions"] as const) {
    test(`rejects an array used as manifest ${field}`, async () => {
      const home = await fixture();
      const path = managedFilesManifestPath(home);
      await mkdir(join(path, ".."), { recursive: true });
      await Bun.write(path, JSON.stringify({
        version: 1,
        files: field === "files" ? [] : {},
        transitions: field === "transitions" ? [] : {},
      }));

      await expect(sync(home, join(home, ".claude", "skill.md"), "fleet")).rejects.toThrow(
        "manifest is invalid",
      );
    });
  }

  test("rejects scalar manifest maps", async () => {
    const home = await fixture();
    const path = managedFilesManifestPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify({ version: 1, files: "invalid", transitions: {} }));

    await expect(sync(home, join(home, ".claude", "skill.md"), "fleet")).rejects.toThrow(
      "manifest is invalid",
    );
  });

  for (const point of [
    "after-transition-manifest",
    "after-destination-write",
    "after-final-manifest",
  ] as const) {
    test(`recovers an interrupted ownership update at ${point}`, async () => {
      const home = await fixture();
      const destination = join(home, ".claude", "skill.md");
      let injected = false;

      await expect(
        withManagedFiles(
          home,
          (session) =>
            session.sync(destination, "intended", {
              provider: "claude-code",
              kind: "skill",
              mode: 0o644,
            }),
          {
            fault: (at) => {
              if (!injected && at === point) {
                injected = true;
                throw new Error(`fault at ${point}`);
              }
            },
          },
        ),
      ).rejects.toThrow(`fault at ${point}`);

      const exists = await Bun.file(destination).exists();
      if (point === "after-transition-manifest") {
        expect(exists).toBe(false);
      } else {
        expect(await Bun.file(destination).text()).toBe("intended");
        expect(await inspectManagedFile(home, destination, "intended", 0o644)).toBe("current");
      }

      const recovered = await withManagedFiles(home, (session) =>
        session.sync(destination, "intended", {
          provider: "claude-code",
          kind: "skill",
          mode: 0o644,
        }),
      );
      expect(["installed", "unchanged"]).toContain(recovered);
      const manifest = await Bun.file(managedFilesManifestPath(home)).json();
      expect(manifest.transitions).toEqual({});
      expect(manifest.files[destination]).toMatchObject({ mode: 0o644 });
    });
  }

  for (const point of ["after-transition-manifest", "after-destination-write"] as const) {
    test(`recognizes previous and intended Fleet hashes during ${point}`, async () => {
      const home = await fixture();
      const destination = join(home, ".claude", "skill.md");
      await withManagedFiles(home, (session) =>
        session.sync(destination, "previous", {
          provider: "claude-code",
          kind: "skill",
          mode: 0o644,
        }),
      );
      let injected = false;
      await expect(
        withManagedFiles(
          home,
          (session) =>
            session.sync(destination, "intended", {
              provider: "claude-code",
              kind: "skill",
              mode: 0o644,
            }),
          {
            fault: (at) => {
              if (!injected && at === point) {
                injected = true;
                throw new Error("crash");
              }
            },
          },
        ),
      ).rejects.toThrow("crash");

      expect(await inspectManagedFile(home, destination, "intended", 0o644)).toBe(
        point === "after-transition-manifest" ? "outdated-owned" : "current",
      );
      expect(
        await withManagedFiles(home, (session) =>
          session.sync(destination, "intended", {
            provider: "claude-code",
            kind: "skill",
            mode: 0o644,
          }),
        ),
      ).toBe("updated");
      expect(await Bun.file(destination).text()).toBe("intended");
    });
  }

  test("recovers after temp chmod fails without exposing unowned destination bytes", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "hook.sh");

    await expect(
      withManagedFiles(
        home,
        (session) =>
          session.sync(destination, "#!/bin/sh\n", {
            provider: "claude-code",
            kind: "plugin",
            mode: 0o755,
          }),
        {
          fault: (point) => {
            if (point === "before-temp-chmod") throw new Error("chmod failed");
          },
        },
      ),
    ).rejects.toThrow("chmod failed");
    expect(await Bun.file(destination).exists()).toBe(false);

    await withManagedFiles(home, (session) =>
      session.sync(destination, "#!/bin/sh\n", {
        provider: "claude-code",
        kind: "plugin",
        mode: 0o755,
      }),
    );
    expect((await stat(destination)).mode & 0o777).toBe(0o755);
  });

  test("updates intended mode atomically and treats later mode drift as a conflict", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "hook.sh");
    await withManagedFiles(home, (session) =>
      session.sync(destination, "hook", {
        provider: "claude-code",
        kind: "plugin",
        mode: 0o644,
      }),
    );

    const updated = await withManagedFiles(home, (session) =>
      session.sync(destination, "hook", {
        provider: "claude-code",
        kind: "plugin",
        mode: 0o755,
      }),
    );
    expect(updated).toBe("updated");
    expect((await stat(destination)).mode & 0o777).toBe(0o755);

    await chmod(destination, 0o700);
    expect(await inspectManagedFile(home, destination, "hook", 0o755)).toBe(
      "conflict-unmanaged",
    );
    expect(
      await withManagedFiles(home, (session) =>
        session.sync(destination, "hook", {
          provider: "claude-code",
          kind: "plugin",
          mode: 0o755,
        }),
      ),
    ).toBe("conflict");
  });

  test("aborts when the validated parent is swapped before temp creation", async () => {
    const home = await fixture();
    const parent = join(home, ".claude");
    const original = join(home, ".claude-original");
    const destination = join(parent, "skill.md");

    await expect(
      withManagedFiles(
        home,
        (session) =>
          session.sync(destination, "fleet", {
            provider: "claude-code",
            kind: "skill",
            mode: 0o644,
          }),
        {
          fault: async (point) => {
            if (point !== "before-temp-create") return;
            await rename(parent, original);
            await mkdir(parent);
          },
        },
      ),
    ).rejects.toThrow("parent directory changed");
    expect(await Bun.file(destination).exists()).toBe(false);
    expect(await Bun.file(join(original, "skill.md")).exists()).toBe(false);
  });

  test("revalidates the parent and destination immediately before rename", async () => {
    const home = await fixture();
    const parent = join(home, ".claude");
    const original = join(home, ".claude-original");
    const destination = join(parent, "skill.md");

    await expect(
      withManagedFiles(
        home,
        (session) =>
          session.sync(destination, "fleet", {
            provider: "claude-code",
            kind: "skill",
            mode: 0o644,
          }),
        {
          fault: async (point) => {
            if (point !== "before-final-rename") return;
            await rename(parent, original);
            await mkdir(parent);
            await Bun.write(destination, "appeared");
          },
        },
      ),
    ).rejects.toThrow("parent directory changed");
    expect(await Bun.file(destination).text()).toBe("appeared");
    expect(await Bun.file(join(original, "skill.md")).exists()).toBe(false);
  });

  test("refuses a destination that appears immediately before rename", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "skill.md");

    await expect(
      withManagedFiles(
        home,
        (session) =>
          session.sync(destination, "fleet", {
            provider: "claude-code",
            kind: "skill",
            mode: 0o644,
          }),
        {
          fault: async (point) => {
            if (point === "before-final-rename") await Bun.write(destination, "user");
          },
        },
      ),
    ).rejects.toThrow("Destination appeared");
    expect(await Bun.file(destination).text()).toBe("user");
  });

  test("rechecks destination identity synchronously after final validation seam", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "skill.md");

    await expect(
      withManagedFiles(
        home,
        (session) =>
          session.sync(destination, "fleet", {
            provider: "claude-code",
            kind: "skill",
            mode: 0o644,
          }),
        { finalValidationFault: () => writeFileSync(destination, "user") },
      ),
    ).rejects.toThrow("Destination appeared");
    expect(await Bun.file(destination).text()).toBe("user");
  });

  test("uses kernel no-replace semantics if an absent destination races into existence", async () => {
    const home = await fixture();
    const destination = join(home, ".claude", "skill.md");

    await expect(
      withManagedFiles(
        home,
        (session) =>
          session.sync(destination, "fleet", {
            provider: "claude-code",
            kind: "skill",
            mode: 0o644,
          }),
        { noReplaceFault: () => writeFileSync(destination, "user") },
      ),
    ).rejects.toThrow(/EEXIST|exist/i);
    expect(await Bun.file(destination).text()).toBe("user");
  });

  test("times out cleanly when another SQLite connection holds the installer transaction", async () => {
    const home = await fixture();
    await withManagedFiles(home, async () => {});
    const database = new Database(managedFilesLockDatabasePath(home));
    database.exec("BEGIN IMMEDIATE");
    try {
      await expect(
        withManagedFiles(home, async () => {}, { lockTimeoutMs: 25 }),
      ).rejects.toThrow(/database is locked|busy/i);
    } finally {
      database.exec("ROLLBACK");
      database.close();
    }
  });

  test("an OS-released SQLite transaction allows progress after a lock-holder crash", async () => {
    const home = await fixture();
    const modulePath = join(import.meta.dir, "..", "src", "managed-fs.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { withManagedFiles } from ${JSON.stringify(modulePath)}; ` +
          `await withManagedFiles(${JSON.stringify(home)}, async () => { ` +
          `console.log("locked"); await Bun.sleep(60_000); });`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");

    await expect(
      withManagedFiles(home, async () => {}, { lockTimeoutMs: 25 }),
    ).rejects.toThrow(/database is locked|busy/i);
    child.kill(9);
    await child.exited;

    await expect(withManagedFiles(home, async () => {}, { lockTimeoutMs: 500 })).resolves.toBeUndefined();
  });

  test("serializes against a concurrent installer process", async () => {
    const home = await fixture();
    const modulePath = join(import.meta.dir, "..", "src", "managed-fs.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { withManagedFiles } from ${JSON.stringify(modulePath)}; ` +
          `await withManagedFiles(${JSON.stringify(home)}, async () => { ` +
          `console.log("locked"); await Bun.sleep(200); });`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    const started = Date.now();

    await expect(withManagedFiles(home, async () => {}, { lockTimeoutMs: 1_000 })).resolves.toBeUndefined();

    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(await child.exited).toBe(0);
  });

  test("refuses a symlinked SQLite lock database", async () => {
    const home = await fixture();
    const lock = managedFilesLockDatabasePath(home);
    await mkdir(join(lock, ".."), { recursive: true });
    const target = join(home, "user-lock-db");
    await Bun.write(target, "user");
    await symlink(target, lock);

    await expect(withManagedFiles(home, async () => {})).rejects.toThrow(
      "unsafe Fleet installer lock database",
    );
    expect(await Bun.file(target).text()).toBe("user");
  });

  test("initializes an exclusively owned Fleet lock database", async () => {
    const home = await fixture();
    await withManagedFiles(home, async () => {});
    const path = managedFilesLockDatabasePath(home);
    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(stats.nlink).toBe(1);

    const database = new Database(path, { readonly: true, strict: true });
    try {
      const application = database.query("PRAGMA application_id").get() as {
        application_id: number;
      };
      const marker = database
        .query("SELECT marker FROM fleet_lock_owner WHERE id = 1")
        .get() as { marker: string };
      expect(application.application_id).not.toBe(0);
      expect(marker.marker).toBe("autosmith-fleet-managed-files-lock-v1");
    } finally {
      database.close();
    }
  });

  test("publishes exactly one valid lock database during concurrent first use", async () => {
    const home = await fixture();
    const modulePath = join(import.meta.dir, "..", "src", "managed-fs.ts");
    const gate = join(home, "publish-gate");
    const ready = [join(home, "ready-1"), join(home, "ready-2")];
    const children = ready.map((readyPath) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { existsSync, writeFileSync } from "node:fs"; ` +
            `import { withManagedFiles } from ${JSON.stringify(modulePath)}; ` +
            `await withManagedFiles(${JSON.stringify(home)}, async () => {}, { ` +
            `lockBootstrapFault: (path) => { writeFileSync(${JSON.stringify(readyPath)}, path); ` +
            `while (!existsSync(${JSON.stringify(gate)})) ` +
            `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } });`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const deadline = Date.now() + 5_000;
    while (!(await Promise.all(ready.map((path) => Bun.file(path).exists()))).every(Boolean)) {
      if (Date.now() >= deadline) throw new Error("concurrent bootstrap did not reach publication");
      await Bun.sleep(5);
    }
    await Bun.write(gate, "go");

    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    await expect(withManagedFiles(home, async () => {})).resolves.toBeUndefined();
    const lock = managedFilesLockDatabasePath(home);
    const names = await readdir(join(lock, ".."));
    expect(names.filter((name) => name.includes(".lock.sqlite.fleet-"))).toEqual([]);
    expect((await stat(lock)).nlink).toBe(1);
  });

  test("a pre-publication fault leaves only an age-cleanable private database", async () => {
    const home = await fixture();
    let privatePath = "";
    await expect(
      withManagedFiles(home, async () => {}, {
        lockBootstrapFault: (path) => {
          privatePath = path;
          throw new Error("bootstrap fault");
        },
      }),
    ).rejects.toThrow("bootstrap fault");

    expect(await Bun.file(managedFilesLockDatabasePath(home)).exists()).toBe(false);
    expect(await Bun.file(privatePath).exists()).toBe(true);
    const old = new Date(Date.now() - MANAGED_ARTIFACT_MAX_AGE_MS - 1_000);
    await utimes(privatePath, old, old);
    await withManagedFiles(home, async () => {});
    expect(await Bun.file(privatePath).exists()).toBe(false);
  });

  test("termination before publication never leaves an unmarked canonical database", async () => {
    const home = await fixture();
    const modulePath = join(import.meta.dir, "..", "src", "managed-fs.ts");
    const ready = join(home, "terminated-private-path");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs"; ` +
          `import { withManagedFiles } from ${JSON.stringify(modulePath)}; ` +
          `await withManagedFiles(${JSON.stringify(home)}, async () => {}, { ` +
          `lockBootstrapFault: (path) => { writeFileSync(${JSON.stringify(ready)}, path); ` +
          `process.kill(process.pid, 9); } });`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).not.toBe(0);
    const privatePath = (await Bun.file(ready).text()).trim();
    expect(await Bun.file(managedFilesLockDatabasePath(home)).exists()).toBe(false);
    expect(await Bun.file(privatePath).exists()).toBe(true);

    const old = new Date(Date.now() - MANAGED_ARTIFACT_MAX_AGE_MS - 1_000);
    await utimes(privatePath, old, old);
    await withManagedFiles(home, async () => {});
    expect(await Bun.file(privatePath).exists()).toBe(false);
  });

  test("termination after publication leaves a valid recoverable canonical database", async () => {
    const home = await fixture();
    const modulePath = join(import.meta.dir, "..", "src", "managed-fs.ts");
    const ready = join(home, "published-private-path");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs"; ` +
          `import { withManagedFiles } from ${JSON.stringify(modulePath)}; ` +
          `await withManagedFiles(${JSON.stringify(home)}, async () => {}, { ` +
          `lockPublishedFault: (privatePath) => { ` +
          `writeFileSync(${JSON.stringify(ready)}, privatePath); process.kill(process.pid, 9); } });`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).not.toBe(0);
    const privatePath = (await Bun.file(ready).text()).trim();
    const canonical = managedFilesLockDatabasePath(home);
    expect(await Bun.file(canonical).exists()).toBe(true);
    expect((await stat(canonical)).nlink).toBe(2);

    await expect(withManagedFiles(home, async () => {})).resolves.toBeUndefined();
    expect((await stat(canonical)).nlink).toBe(1);
    expect(await Bun.file(privatePath).exists()).toBe(false);
  });

  test("concurrent processes idempotently recover the same published private alias", async () => {
    const home = await fixture();
    await withManagedFiles(home, async () => {});
    const canonical = managedFilesLockDatabasePath(home);
    const alias = join(
      canonical,
      "..",
      `.managed-files-v1.lock.sqlite.fleet-999-${crypto.randomUUID()}.tmp`,
    );
    await link(canonical, alias);
    expect((await stat(canonical)).nlink).toBe(2);

    const modulePath = join(import.meta.dir, "..", "src", "managed-fs.ts");
    const gate = join(home, "recovery-gate");
    const ready = [join(home, "recover-ready-1"), join(home, "recover-ready-2")];
    const children = ready.map((readyPath) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { existsSync, writeFileSync } from "node:fs"; ` +
            `import { withManagedFiles } from ${JSON.stringify(modulePath)}; ` +
            `await withManagedFiles(${JSON.stringify(home)}, async () => {}, { ` +
            `lockAliasRecoveryFault: () => { writeFileSync(${JSON.stringify(readyPath)}, "ready"); ` +
            `while (!existsSync(${JSON.stringify(gate)})) ` +
            `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } });`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const deadline = Date.now() + 5_000;
    while (!(await Promise.all(ready.map((path) => Bun.file(path).exists()))).every(Boolean)) {
      if (Date.now() >= deadline) throw new Error("concurrent recovery did not observe alias");
      await Bun.sleep(5);
    }
    await Bun.write(gate, "go");

    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    expect((await stat(canonical)).nlink).toBe(1);
    expect(await Bun.file(alias).exists()).toBe(false);
    await expect(withManagedFiles(home, async () => {})).resolves.toBeUndefined();
  });

  for (const contents of ["", "not sqlite"] as const) {
    test(`rejects and preserves an existing ${contents ? "unknown" : "empty"} lock database`, async () => {
      const home = await fixture();
      const path = managedFilesLockDatabasePath(home);
      await mkdir(join(path, ".."), { recursive: true });
      await Bun.write(path, contents);
      await chmod(path, 0o600);
      const inode = (await stat(path)).ino;

      await expect(withManagedFiles(home, async () => {})).rejects.toThrow(
        "unrecognized Fleet installer lock database",
      );
      expect(await Bun.file(path).text()).toBe(contents);
      expect((await stat(path)).ino).toBe(inode);
    });
  }

  test("rejects and preserves a valid non-Fleet SQLite database", async () => {
    const home = await fixture();
    const path = managedFilesLockDatabasePath(home);
    await mkdir(join(path, ".."), { recursive: true });
    const database = new Database(path, { create: true });
    database.exec("CREATE TABLE user_data (value TEXT NOT NULL)");
    database.query("INSERT INTO user_data (value) VALUES (?)").run("keep me");
    database.close();
    await chmod(path, 0o600);

    await expect(withManagedFiles(home, async () => {})).rejects.toThrow(
      "unrecognized Fleet installer lock database",
    );
    const preserved = new Database(path, { readonly: true });
    try {
      expect(preserved.query("SELECT value FROM user_data").get()).toEqual({ value: "keep me" });
    } finally {
      preserved.close();
    }
  });

  test("rejects and preserves a hard-linked main lock database", async () => {
    const home = await fixture();
    const path = managedFilesLockDatabasePath(home);
    await mkdir(join(path, ".."), { recursive: true });
    const target = join(home, "user-database");
    await Bun.write(target, "user");
    await chmod(target, 0o600);
    await link(target, path);

    await expect(withManagedFiles(home, async () => {})).rejects.toThrow(
      /Fleet installer lock database/,
    );
    expect(await Bun.file(target).text()).toBe("user");
    expect((await stat(target)).nlink).toBe(2);
  });

  test("rejects and preserves random and hard-linked journal sidecars", async () => {
    for (const hardLinked of [false, true]) {
      const home = await fixture();
      await withManagedFiles(home, async () => {});
      const journal = `${managedFilesLockDatabasePath(home)}-journal`;
      const target = join(home, `journal-${hardLinked}`);
      await Bun.write(target, "user journal");
      await chmod(target, 0o600);
      if (hardLinked) await link(target, journal);
      else await Bun.write(journal, "user journal");
      await chmod(journal, 0o600);

      await expect(withManagedFiles(home, async () => {})).rejects.toThrow(
        hardLinked ? "unsafe Fleet installer lock database sidecar" : "unrecognized Fleet installer lock database sidecar",
      );
      expect(await Bun.file(journal).text()).toBe("user journal");
      if (hardLinked) expect((await stat(target)).nlink).toBe(2);
    }
  });

  test("cleans old Fleet temps while preserving fresh, unrelated, and legacy lock files", async () => {
    const home = await fixture();
    const parent = join(home, ".claude");
    const manifestDirectory = join(managedFilesManifestPath(home), "..");
    await mkdir(manifestDirectory, { recursive: true });
    const uuid = "00000000-0000-4000-8000-000000000000";
    const oldTemp = join(parent, `.skill.md.fleet-123-${uuid}.tmp`);
    const freshTemp = join(parent, `.other.md.fleet-123-${uuid}.tmp`);
    const unrelated = join(parent, ".user.tmp");
    const oldLock = join(manifestDirectory, "managed-files-v1.json.lock");
    const quarantine = join(
      manifestDirectory,
      `managed-files-v1.json.lock.fleet-quarantine-${uuid}`,
    );
    for (const path of [oldTemp, freshTemp, unrelated, oldLock, quarantine]) {
      await Bun.write(path, "temp");
    }
    const old = new Date(Date.now() - MANAGED_ARTIFACT_MAX_AGE_MS - 1_000);
    for (const path of [oldTemp, unrelated, oldLock, quarantine]) await utimes(path, old, old);

    await sync(home, join(parent, "skill.md"), "fleet");

    expect(await Bun.file(oldTemp).exists()).toBe(false);
    expect(await Bun.file(oldLock).exists()).toBe(true);
    expect(await Bun.file(quarantine).exists()).toBe(true);
    expect(await Bun.file(freshTemp).exists()).toBe(true);
    expect(await Bun.file(unrelated).exists()).toBe(true);
  });
});
