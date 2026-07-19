import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("parses a valid config file into a FleetShipConfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-ship-config-"));
    try {
      const path = join(dir, "fleet-ship-config.yaml");
      await Bun.write(
        path,
        `fleetDirectory: ./fleet\nport: 4700\nname: test-ship\n`,
      );

      const config = await loadConfig(path);
      expect(config.name).toBe("test-ship");
      expect(config.port).toBe(4700);
      // fleetDirectory is resolved to an absolute path (relative to cwd).
      expect(config.fleetDirectory.endsWith("/fleet")).toBe(true);
      expect(config.fleetDirectory.startsWith("/")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when the file does not exist", async () => {
    await expect(loadConfig("/nonexistent/fleet-ship-config.yaml")).rejects.toThrow();
  });

  test("throws when the file is not valid YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-ship-config-"));
    try {
      const path = join(dir, "bad.yaml");
      await Bun.write(path, "not: valid: yaml: at: all: [");
      await expect(loadConfig(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when required fields are missing or mistyped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-ship-config-"));
    try {
      const missingPort = join(dir, "missing-port.yaml");
      await Bun.write(missingPort, `fleetDirectory: ./fleet\nname: test-ship\n`);
      await expect(loadConfig(missingPort)).rejects.toThrow(/port/);

      const wrongType = join(dir, "wrong-type.yaml");
      await Bun.write(wrongType, `fleetDirectory: ./fleet\nport: "not-a-number"\nname: test-ship\n`);
      await expect(loadConfig(wrongType)).rejects.toThrow(/port/);

      const notAMapping = join(dir, "not-a-mapping.yaml");
      await Bun.write(notAMapping, `- one\n- two\n`);
      await expect(loadConfig(notAMapping)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
