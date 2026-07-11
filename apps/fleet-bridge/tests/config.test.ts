import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("bridge loadConfig", () => {
  test("parses a valid config into a BridgeConfig with an absolute dataDirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-bridge-config-"));
    try {
      const path = join(dir, "fleet-bridge-config.yaml");
      await Bun.write(path, `dataDirectory: ./bridge-data\nport: 4800\nname: test-bridge\n`);

      const config = await loadConfig(path);
      expect(config.name).toBe("test-bridge");
      expect(config.port).toBe(4800);
      expect(config.dataDirectory.startsWith("/")).toBe(true);
      expect(config.dataDirectory.endsWith("/bridge-data")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when the file does not exist", async () => {
    await expect(loadConfig("/nonexistent/fleet-bridge-config.yaml")).rejects.toThrow();
  });

  test("throws when required fields are missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-bridge-config-"));
    try {
      const path = join(dir, "missing-port.yaml");
      await Bun.write(path, `dataDirectory: ./bridge-data\nname: test-bridge\n`);
      await expect(loadConfig(path)).rejects.toThrow(/port/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
