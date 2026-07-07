import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStore, saveStore, storePath } from "../../apps/fleet-bridge/src/store";

describe("ship roster store", () => {
  test("a missing file loads as an empty roster", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    try {
      expect(await loadStore(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("save then load round-trips the roster", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    try {
      const ships = [
        { name: "ship-a", url: "http://localhost:4700" },
        { name: "ship-b", url: "http://localhost:4701" },
      ];
      await saveStore(dir, ships);

      // Written as the versioned envelope.
      const raw = JSON.parse(await Bun.file(storePath(dir)).text());
      expect(raw.version).toBe(1);

      expect(await loadStore(dir)).toEqual(ships);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a malformed roster file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-bridge-store-"));
    try {
      await Bun.write(storePath(dir), JSON.stringify({ version: 2, ships: "nope" }));
      await expect(loadStore(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
