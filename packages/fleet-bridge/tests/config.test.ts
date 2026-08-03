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

  test("insecureNoAuth is off unless a flag or the environment asks for it", () => {
    const base = { dataDirectory: "./bridge-data", port: 4800, name: "test-bridge" };
    expect(resolveBridgeConfig(base, { env: {} }).insecureNoAuth).toBe(false);
    expect(resolveBridgeConfig(base, { env: { FLEET_INSECURE_NO_AUTH: "0" } }).insecureNoAuth).toBe(false);
    expect(resolveBridgeConfig(base, { env: { FLEET_INSECURE_NO_AUTH: "1" } }).insecureNoAuth).toBe(true);
    expect(resolveBridgeConfig({ ...base, insecureNoAuth: true }, { env: {} }).insecureNoAuth).toBe(true);
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
