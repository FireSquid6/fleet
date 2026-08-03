import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EdenFleetBridge } from "../src/data/eden";
import { makeBridgeClient } from "../src/data/client";
import { MockFleetBridge } from "../src/data/mock";
import { abbreviateRevision, formatBytes, stripSection, syncStatus } from "../src/lib/armory";
import type { ArmoryFile, ArmoryManifest, ArmoryShipState, ArmorySyncState } from "../src/data/types";

const REVISION = "a".repeat(64);
const OTHER_REVISION = "b".repeat(64);

const MANIFEST: ArmoryManifest = {
  revision: REVISION,
  entries: [
    { path: "dotfiles/tmux.conf", section: "dotfiles", size: 12, sha256: "c".repeat(64), mode: 0o644 },
    { path: "skills/one/SKILL.md", section: "skills", size: 7, sha256: "d".repeat(64), mode: 0o644 },
  ],
  dotfileMap: { "tmux.conf": "~/.tmux.conf" },
};

const FILE: ArmoryFile = {
  path: "skills/one/SKILL.md",
  section: "skills",
  size: 7,
  sha256: "d".repeat(64),
  mode: 0o644,
  encoding: "utf8",
  contents: "# skill",
};

const SHIP_STATES: ArmoryShipState[] = [
  { ship: "forge-01", status: "online", state: null },
  { ship: "forge-02", status: "offline", state: null },
];

describe("EdenFleetBridge armory reads", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: { method: string; path: string; query: Record<string, string>; search: string }[];
  let bridge: EdenFleetBridge;
  /** Overrides the canned body for a path, to drive the failure cases. */
  let override: Map<string, unknown>;

  beforeEach(() => {
    requests = [];
    override = new Map();
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          search: url.search,
        });
        if (override.has(url.pathname)) return Response.json(override.get(url.pathname));
        if (url.pathname === "/armory") return Response.json(MANIFEST);
        if (url.pathname === "/armory/file") return Response.json(FILE);
        if (url.pathname === "/armory/ships") return Response.json(SHIP_STATES);
        return Response.json({ error: "unexpected route" }, { status: 404 });
      },
    });
    bridge = new EdenFleetBridge(makeBridgeClient(`http://localhost:${server.port}`));
  });

  afterEach(() => server.stop(true));

  test("getArmory GETs /armory and returns the manifest", async () => {
    expect(await bridge.getArmory()).toEqual(MANIFEST);
    expect(requests).toEqual([{ method: "GET", path: "/armory", query: {}, search: "" }]);
  });

  test("getArmoryFile GETs /armory/file with the path as a query parameter", async () => {
    expect(await bridge.getArmoryFile("skills/one/SKILL.md")).toEqual(FILE);
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/armory/file",
        query: { path: "skills/one/SKILL.md" },
        search: requests[0]!.search,
      },
    ]);
  });

  test("getArmoryFile encodes a path with separators and a space", async () => {
    await bridge.getArmoryFile("dotfiles/nvim/my config.lua");

    expect(requests[0]!.query).toEqual({ path: "dotfiles/nvim/my config.lua" });
    // A raw space would be an invalid request line; the treaty must escape it.
    expect(requests[0]!.search).not.toContain(" ");
  });

  test("listArmoryShips GETs /armory/ships and returns the rows", async () => {
    expect(await bridge.listArmoryShips()).toEqual(SHIP_STATES);
    expect(requests).toEqual([{ method: "GET", path: "/armory/ships", query: {}, search: "" }]);
  });

  test("an in-band { error } body on a 200 throws rather than returning it", async () => {
    override.set("/armory", { error: "armory/dotfile-map.json is not valid JSON" });
    override.set("/armory/file", { error: "no such armory file" });
    override.set("/armory/ships", { error: "bridge is shutting down" });

    await expect(bridge.getArmory()).rejects.toThrow("fleet-bridge request failed");
    await expect(bridge.getArmoryFile("skills/one/SKILL.md")).rejects.toThrow("fleet-bridge request failed");
    await expect(bridge.listArmoryShips()).rejects.toThrow("fleet-bridge request failed");
  });
});

describe("MockFleetBridge armory fixture", () => {
  test("every manifest entry can be read back with matching facts", async () => {
    const mock = new MockFleetBridge();
    const manifest = await mock.getArmory();

    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.revision).toMatch(/^[0-9a-f]{64}$/);
    for (const entry of manifest.entries) {
      const file = await mock.getArmoryFile(entry.path);
      expect(file).toMatchObject(entry);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("entries are sorted by path and cover all three sections", async () => {
    const paths = (await new MockFleetBridge().getArmory()).entries.map((e) => e.path);

    expect(paths).toEqual([...paths].sort());
    for (const section of ["skills", "plugins", "dotfiles"]) {
      expect(paths.some((p) => p.startsWith(`${section}/`))).toBe(true);
    }
  });

  test("every dotfileMap key has a matching dotfiles/ entry", async () => {
    const manifest = await new MockFleetBridge().getArmory();
    const paths = new Set(manifest.entries.map((e) => e.path));

    expect(Object.keys(manifest.dotfileMap).length).toBeGreaterThan(0);
    for (const source of Object.keys(manifest.dotfileMap)) {
      expect(paths.has(`dotfiles/${source}`)).toBe(true);
    }
  });

  test("the fixture carries a binary file, so the viewer's placeholder is reachable", async () => {
    const mock = new MockFleetBridge();
    const manifest = await mock.getArmory();
    const files = await Promise.all(manifest.entries.map((e) => mock.getArmoryFile(e.path)));

    expect(files.some((f) => f.encoding === "base64")).toBe(true);
  });

  test("ship states cover in sync, behind and never synced", async () => {
    const mock = new MockFleetBridge();
    const manifest = await mock.getArmory();
    const rows = await mock.listArmoryShips();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.state) expect(row.state.revision === null || typeof row.state.revision === "string").toBe(true);
    }
    const statuses = rows.map((row) => syncStatus(manifest.revision, row.state));
    expect(statuses).toContain("in sync");
    expect(statuses).toContain("behind");
    expect(statuses).toContain("never synced");
    expect(statuses).toContain("error");
  });

  test("getArmoryFile rejects an unknown path", async () => {
    await expect(new MockFleetBridge().getArmoryFile("skills/nope.md")).rejects.toThrow("armory file not found");
  });

  test("a ship registered during the session has no armory state", async () => {
    const mock = new MockFleetBridge();
    await mock.createShip("http://new-ship:4800");

    const row = (await mock.listArmoryShips()).find((r) => r.ship === "new-ship");
    expect(row).toEqual({ ship: "new-ship", status: "online", state: null });
  });
});

describe("syncStatus", () => {
  const state = (patch: Partial<ArmorySyncState>): ArmorySyncState => ({
    revision: REVISION,
    bridgeUrl: "http://bridge:4800",
    syncedAt: "2026-07-26T00:00:00.000Z",
    fileCount: 3,
    install: null,
    lastError: null,
    ...patch,
  });

  test("matching revisions are in sync, differing ones are behind", () => {
    expect(syncStatus(REVISION, state({}))).toBe("in sync");
    expect(syncStatus(REVISION, state({ revision: OTHER_REVISION }))).toBe("behind");
  });

  test("a null revision is never synced", () => {
    expect(syncStatus(REVISION, state({ revision: null }))).toBe("never synced");
  });

  test("lastError outranks the revision comparison", () => {
    expect(syncStatus(REVISION, state({ lastError: "pull failed" }))).toBe("error");
    expect(syncStatus(REVISION, state({ revision: null, lastError: "pull failed" }))).toBe("error");
  });

  test("a ship the bridge could not ask is unknown", () => {
    expect(syncStatus(REVISION, null)).toBe("unknown");
  });
});

describe("armory display helpers", () => {
  test("abbreviateRevision takes the first 12 characters and handles null", () => {
    expect(abbreviateRevision(REVISION)).toBe("a".repeat(12));
    expect(abbreviateRevision(null)).toBe("—");
  });

  test("stripSection removes the group prefix and leaves anything else alone", () => {
    expect(stripSection("skills/one/SKILL.md", "skills")).toBe("one/SKILL.md");
    expect(stripSection("one/SKILL.md", "skills")).toBe("one/SKILL.md");
  });

  test("formatBytes scales past a kilobyte", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
