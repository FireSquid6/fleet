/**
 * armory-cache.test.ts — drives `ArmoryCache` against a real HTTP bridge
 * (`Bun.serve`) and a temp home. The fake bridge is real rather than a stubbed
 * `fetch` because the whole point of the cache is what it does with bytes off
 * the wire; it also counts requests, which is how "downloads nothing" is
 * asserted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmoryEntry, ArmoryManifest } from "fleet-protocol";
import { ArmoryCache, ArmorySyncError } from "../src/armory/armory-cache";
import { createApp } from "../src/api";
import { stubConfig, stubManager } from "./helpers";

const homes: string[] = [];
const servers: { stop(): void }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fleet-ship-armory-"));
  homes.push(home);
  return home;
}

const sha256 = (contents: Uint8Array): string => new Bun.CryptoHasher("sha256").update(contents).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface FakeFile {
  bytes: Uint8Array;
  mode?: number;
  /** Bytes actually served, when they should differ from what the manifest promises. */
  served?: Uint8Array;
}

/** A bridge serving `files` (path → contents) plus whatever extra entries a test injects. */
function fakeBridge(files: Map<string, FakeFile>, extraEntries: ArmoryEntry[] = []) {
  const requests: string[] = [];

  const entries = (): ArmoryEntry[] => [
    ...[...files.entries()]
      .map(([path, file]) => ({
        path,
        section: path.split("/")[0] as ArmoryEntry["section"],
        size: file.bytes.byteLength,
        sha256: sha256(file.bytes),
        mode: file.mode ?? 0o644,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    ...extraEntries,
  ];

  const manifest = (): ArmoryManifest => {
    const list = entries();
    return {
      revision: new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(list.map(({ path, sha256: hash, mode }) => ({ path, hash, mode }))))
        .digest("hex"),
      entries: list,
      dotfileMap: {},
    };
  };

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      if (url.pathname === "/armory") return Response.json(manifest());
      if (url.pathname === "/armory/file") {
        const path = url.searchParams.get("path") ?? "";
        const entry = entries().find((candidate) => candidate.path === path);
        const file = files.get(path);
        if (!entry || !file) return new Response("not found", { status: 404 });
        const bytes = file.served ?? file.bytes;
        const text = tryDecode(bytes);
        return Response.json({
          ...entry,
          ...(text === undefined
            ? { encoding: "base64", contents: Buffer.from(bytes).toString("base64") }
            : { encoding: "utf8", contents: text }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);

  return {
    url: `http://localhost:${server.port}`,
    requests,
    revision: () => manifest().revision,
    fileRequests: () => requests.filter((path) => path.startsWith("/armory/file")),
  };
}

function tryDecode(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The cache's mirrored tree root under a temp home. */
const filesRoot = (home: string): string => join(home, ".config", "autosmith", "fleet-ship", "armory", "files");

const read = (home: string, path: string): Promise<string> => Bun.file(join(filesRoot(home), path)).text();

/** The error `promise` rejected with, failing the test if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

describe("ArmoryCache", () => {
  test("a first sync writes every file with its contents and mode, and records the revision", async () => {
    const home = await makeHome();
    const bridge = fakeBridge(
      new Map([
        ["skills/one/SKILL.md", { bytes: utf8("# one") }],
        ["skills/one/run.sh", { bytes: utf8("#!/bin/sh\n"), mode: 0o755 }],
        ["dotfiles/gitconfig", { bytes: utf8("[user]\n") }],
      ]),
    );
    const cache = new ArmoryCache({ homeDirectory: home });

    const state = await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    expect(state.revision).toBe(bridge.revision());
    expect(state.bridgeUrl).toBe(bridge.url);
    expect(state.fileCount).toBe(3);
    expect(state.lastError).toBeNull();
    expect(state.syncedAt).not.toBeNull();
    expect(await read(home, "skills/one/SKILL.md")).toBe("# one");
    expect(await read(home, "dotfiles/gitconfig")).toBe("[user]\n");
    expect((await lstat(join(filesRoot(home), "skills/one/run.sh"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(filesRoot(home), "skills/one/SKILL.md"))).mode & 0o777).toBe(0o644);
    expect(await cache.state()).toEqual(state);
  });

  test("an unchanged revision downloads nothing", async () => {
    const home = await makeHome();
    const bridge = fakeBridge(new Map([["skills/one/SKILL.md", { bytes: utf8("# one") }]]));
    const cache = new ArmoryCache({ homeDirectory: home });

    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });
    expect(bridge.fileRequests()).toHaveLength(1);

    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });
    expect(bridge.fileRequests()).toHaveLength(1);
  });

  test("a changed file is re-downloaded, a removed one pruned, and an emptied directory removed", async () => {
    const home = await makeHome();
    const files = new Map<string, FakeFile>([
      ["skills/one/SKILL.md", { bytes: utf8("# one") }],
      ["skills/gone/SKILL.md", { bytes: utf8("# gone") }],
    ]);
    const bridge = fakeBridge(files);
    const cache = new ArmoryCache({ homeDirectory: home });
    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    files.set("skills/one/SKILL.md", { bytes: utf8("# one, edited") });
    files.delete("skills/gone/SKILL.md");
    const state = await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    expect(state.fileCount).toBe(1);
    expect(await read(home, "skills/one/SKILL.md")).toBe("# one, edited");
    expect(await readdir(join(filesRoot(home), "skills"))).toEqual(["one"]);
  });

  test("binary entries round-trip byte-exactly through base64", async () => {
    const home = await makeHome();
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 0, 128]);
    const bridge = fakeBridge(new Map([["plugins/claude/blob.bin", { bytes }]]));
    const cache = new ArmoryCache({ homeDirectory: home });

    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    const written = new Uint8Array(await Bun.file(join(filesRoot(home), "plugins/claude/blob.bin")).arrayBuffer());
    expect([...written]).toEqual([...bytes]);
  });

  test("a file whose bytes do not match the manifest hash fails the sync and leaves the applied state intact", async () => {
    const home = await makeHome();
    const files = new Map<string, FakeFile>([["skills/one/SKILL.md", { bytes: utf8("# one") }]]);
    const bridge = fakeBridge(files);
    const cache = new ArmoryCache({ homeDirectory: home });
    const good = await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    files.set("skills/two/SKILL.md", { bytes: utf8("# two"), served: utf8("# tampered") });
    const error = await rejection(cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() }));

    expect(error).toBeInstanceOf(ArmorySyncError);
    expect(error.message).toContain("skills/two/SKILL.md");
    const state = await cache.state();
    expect(state.revision).toBe(good.revision);
    expect(state.fileCount).toBe(1);
    expect(state.lastError).toContain("skills/two/SKILL.md");
  });

  test("a manifest with a traversing path is rejected wholesale and writes nothing", async () => {
    const home = await makeHome();
    const evil = utf8("owned");
    const bridge = fakeBridge(new Map([["skills/one/SKILL.md", { bytes: utf8("# one") }]]), [
      { path: "../../evil", section: "skills", size: evil.byteLength, sha256: sha256(evil), mode: 0o644 },
    ]);
    const cache = new ArmoryCache({ homeDirectory: home });

    const error = await rejection(cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() }));

    expect(error).toBeInstanceOf(ArmorySyncError);
    expect(error.message).toContain("safe armory-relative path");
    expect(bridge.fileRequests()).toHaveLength(0);
    expect(await Bun.file(join(filesRoot(home), "skills/one/SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(home, ".config", "autosmith", "evil")).exists()).toBe(false);
  });

  test("state() on a cold cache is zeroed rather than throwing", async () => {
    const cache = new ArmoryCache({ homeDirectory: await makeHome() });

    expect(await cache.state()).toEqual({
      revision: null,
      bridgeUrl: null,
      syncedAt: null,
      fileCount: 0,
      lastError: null,
    });
  });

  test("a failed sync records lastError and the next success clears it", async () => {
    const home = await makeHome();
    const bridge = fakeBridge(new Map([["skills/one/SKILL.md", { bytes: utf8("# one") }]]));
    const cache = new ArmoryCache({ homeDirectory: home });
    const revision = bridge.revision();

    await rejection(cache.sync({ bridgeUrl: "http://127.0.0.1:1/", revision }));
    expect((await cache.state()).lastError).not.toBeNull();

    const state = await cache.sync({ bridgeUrl: bridge.url, revision });
    expect(state.lastError).toBeNull();
    expect((await cache.state()).lastError).toBeNull();
  });

  test("a malformed push is a 400 and never reaches the bridge", async () => {
    const bridge = fakeBridge(new Map());
    const cache = new ArmoryCache({ homeDirectory: await makeHome() });

    const error = await rejection(cache.sync({ bridgeUrl: "file:///etc", revision: "a".repeat(64) }));

    expect(error).toMatchObject({ status: 400 });
    expect(bridge.requests).toHaveLength(0);
  });

  test("a path that turns from a file into a directory is replaced, not wedged", async () => {
    const home = await makeHome();
    const files = new Map<string, FakeFile>([["skills/one", { bytes: utf8("# one") }]]);
    const bridge = fakeBridge(files);
    const cache = new ArmoryCache({ homeDirectory: home });
    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    files.delete("skills/one");
    files.set("skills/one/SKILL.md", { bytes: utf8("# nested") });
    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    expect(await read(home, "skills/one/SKILL.md")).toBe("# nested");
  });

  test("the routes report the cache and surface a failed pull as 502", async () => {
    const home = await makeHome();
    const bridge = fakeBridge(new Map([["skills/one/SKILL.md", { bytes: utf8("# one") }]]));
    const app = createApp(stubManager(), stubConfig, undefined, undefined, new ArmoryCache({ homeDirectory: home }));
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await app.handle(
        new Request(`http://ship${path}`, {
          method,
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      return { status: response.status, body: await response.json() };
    };
    const revision = bridge.revision();

    expect((await call("GET", "/armory")).body).toMatchObject({ revision: null, fileCount: 0 });
    expect((await call("POST", "/armory/sync", { bridgeUrl: bridge.url, revision })).body).toMatchObject({
      revision,
      fileCount: 1,
    });
    expect((await call("GET", "/armory")).body).toMatchObject({ revision, fileCount: 1 });

    const failed = await call("POST", "/armory/sync", { bridgeUrl: "http://127.0.0.1:1/", revision });
    expect(failed.status).toBe(502);
    expect((await call("POST", "/armory/sync", { bridgeUrl: "not-a-url", revision })).status).toBe(400);
  });

  test("a cached file that was corrupted on disk is re-downloaded", async () => {
    const home = await makeHome();
    const bridge = fakeBridge(new Map([["skills/one/SKILL.md", { bytes: utf8("# one") }]]));
    const cache = new ArmoryCache({ homeDirectory: home });
    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    // Same size, different bytes: only the hash check can catch this.
    await writeFile(join(filesRoot(home), "skills/one/SKILL.md"), "# ONE");
    // Force the pull past the unchanged-revision shortcut, as a bridge restart would.
    await rm(join(home, ".config", "autosmith", "fleet-ship", "armory", "state.json"));
    await cache.sync({ bridgeUrl: bridge.url, revision: bridge.revision() });

    expect(await read(home, "skills/one/SKILL.md")).toBe("# one");
  });
});
