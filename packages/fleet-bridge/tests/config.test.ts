import { describe, expect, test } from "bun:test";
import { resolveBridgeConfig } from "../src/config";

describe("resolveBridgeConfig", () => {
  test("validates a config and resolves dataDirectory to an absolute path", () => {
    const config = resolveBridgeConfig({ dataDirectory: "./bridge-data", port: 4800, name: "test-bridge" });
    expect(config.name).toBe("test-bridge");
    expect(config.port).toBe(4800);
    expect(config.dataDirectory.startsWith("/")).toBe(true);
    expect(config.dataDirectory.endsWith("/bridge-data")).toBe(true);
  });

  test("throws when required fields are missing", () => {
    expect(() => resolveBridgeConfig({ dataDirectory: "./bridge-data", name: "test-bridge" })).toThrow(/port/);
  });

  test("throws when a field is mistyped", () => {
    expect(() =>
      resolveBridgeConfig({ dataDirectory: "./bridge-data", port: "not-a-number", name: "test-bridge" }),
    ).toThrow(/port/);
  });
});
