import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeFleetDirectory, resolveFleetShipConfig } from "../src/config";

describe("resolveFleetShipConfig", () => {
  test("validates a config and resolves fleetDirectory to an absolute path", () => {
    const config = resolveFleetShipConfig({ fleetDirectory: "./fleet", port: 4700, name: "test-ship" });
    expect(config.name).toBe("test-ship");
    expect(config.port).toBe(4700);
    expect(config.fleetDirectory.startsWith("/")).toBe(true);
    expect(config.fleetDirectory.endsWith("/fleet")).toBe(true);
  });

  test("throws when required fields are missing or mistyped", () => {
    expect(() => resolveFleetShipConfig({ fleetDirectory: "./fleet", name: "test-ship" })).toThrow(/port/);
    expect(() =>
      resolveFleetShipConfig({ fleetDirectory: "./fleet", port: "not-a-number", name: "test-ship" }),
    ).toThrow(/port/);
  });

  test("creates and canonicalizes the fleet directory once before startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-ship-config-"));
    try {
      const target = join(dir, "target", "fleet");
      const link = join(dir, "fleet-link");
      await canonicalizeFleetDirectory({ fleetDirectory: target, port: 4700, name: "ship" });
      await symlink(target, link);

      const config = await canonicalizeFleetDirectory({ fleetDirectory: link, port: 4700, name: "ship" });
      expect(config.fleetDirectory).toBe(await realpath(target));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
