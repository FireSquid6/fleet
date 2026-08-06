import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearSession,
  readSession,
  sessionDirectory,
  sessionFile,
  writeSession,
  type Session,
} from "../src/credentials";

const BRIDGE = "http://localhost:4800";
const SESSION: Session = { token: "secret-token", username: "admin" };

describe("credentials", () => {
  let state: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    state = await mkdtemp(join(tmpdir(), "fleet-cli-kit-state-"));
    env = { XDG_STATE_HOME: state };
  });

  afterEach(() => rm(state, { recursive: true, force: true }));

  test("a written session reads back", async () => {
    await writeSession(BRIDGE, SESSION, { env });
    expect(await readSession(BRIDGE, { env })).toEqual(SESSION);
  });

  test("the file is 0600 inside a 0700 directory", async () => {
    await writeSession(BRIDGE, SESSION, { env });

    const file = await stat(sessionFile(BRIDGE, { env }));
    const directory = await stat(sessionDirectory(BRIDGE, { env }));
    expect(file.mode & 0o777).toBe(0o600);
    expect(directory.mode & 0o777).toBe(0o700);
  });

  test("a pre-existing world-readable file is replaced, not loosened", async () => {
    const target = sessionFile(BRIDGE, { env });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "{}", { mode: 0o666 });

    await writeSession(BRIDGE, SESSION, { env });

    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readSession(BRIDGE, { env })).toEqual(SESSION);
  });

  test("no temporary file is left behind", async () => {
    await writeSession(BRIDGE, SESSION, { env });
    const entries = [...new Bun.Glob("*").scanSync(sessionDirectory(BRIDGE, { env }))];
    expect(entries).toEqual(["session.json"]);
  });

  test("FLEET_TOKEN wins over the file and is never written to disk", async () => {
    const withToken = { env: { ...env, FLEET_TOKEN: "from-ci" } };

    expect(await readSession(BRIDGE, withToken)).toEqual({ token: "from-ci", username: null });
    expect(await Bun.file(sessionFile(BRIDGE, withToken)).exists()).toBe(false);

    await writeSession(BRIDGE, SESSION, { env });
    expect(await readSession(BRIDGE, withToken)).toEqual({ token: "from-ci", username: null });
  });

  test("an unset or blank FLEET_TOKEN falls through to the file", async () => {
    await writeSession(BRIDGE, SESSION, { env });
    expect(await readSession(BRIDGE, { env: { ...env, FLEET_TOKEN: "  " } })).toEqual(SESSION);
  });

  test("no session yet reads as null", async () => {
    expect(await readSession(BRIDGE, { env })).toBeNull();
  });

  test("a corrupt or tokenless file reads as no session rather than throwing", async () => {
    const target = sessionFile(BRIDGE, { env });
    await mkdir(dirname(target), { recursive: true });

    for (const contents of ["not json at all", "[]", '"a string"', "{}", '{"token":""}', "null"]) {
      await writeFile(target, contents);
      expect(await readSession(BRIDGE, { env })).toBeNull();
    }
  });

  test("clearSession removes the file and tolerates a missing one", async () => {
    await writeSession(BRIDGE, SESSION, { env });
    await clearSession(BRIDGE, { env });
    expect(await readSession(BRIDGE, { env })).toBeNull();
    await clearSession(BRIDGE, { env });
  });

  test("bridges that differ only after sanitizing still get their own file", async () => {
    const urls = [
      "http://a.example",
      "https://a.example",
      "http://a.example:80",
      "http://a-example",
      "http://a/example",
      "http://a.example/example",
      "http://user@a.example",
      "http://localhost:4800",
      "http://localhost:4801",
    ];

    const paths = urls.map((url) => sessionFile(url, { env }));
    expect(new Set(paths).size).toBe(urls.length);
  });

  test("URLs that normalize to the same bridge share one file", async () => {
    await writeSession("localhost:4800", SESSION, { env });
    expect(await readSession("4800", { env })).toEqual(SESSION);
    expect(await readSession("http://localhost:4800/", { env })).toEqual(SESSION);
  });

  test("the slug keeps the host legible", () => {
    expect(sessionDirectory(BRIDGE, { env }).split("/").at(-1)).toStartWith("localhost-4800-");
  });

  test("XDG_STATE_HOME falls back to ~/.local/state", () => {
    const path = sessionFile(BRIDGE, { env: { HOME: "/home/nobody" } });
    expect(path).toStartWith("/home/nobody/.local/state/fleet-client-cli/");
  });
});
