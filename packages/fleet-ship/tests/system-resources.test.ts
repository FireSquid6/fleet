import { describe, expect, test } from "bun:test";
import { collectSystemResources } from "../src/api/system-resources";

describe("collectSystemResources", () => {
  test("reports plausible host resource values", async () => {
    const r = await collectSystemResources();

    expect(r.uptimeSeconds).toBeGreaterThan(0);

    expect(r.os.type.length).toBeGreaterThan(0);
    expect(r.os.platform.length).toBeGreaterThan(0);
    expect(r.os.hostname.length).toBeGreaterThan(0);

    expect(r.cpu.cores).toBeGreaterThan(0);
    expect(r.cpu.usage).toBeGreaterThanOrEqual(0);
    expect(r.cpu.usage).toBeLessThanOrEqual(1);
    expect(r.cpu.loadAverage).toHaveLength(3);

    expect(r.memory.total).toBeGreaterThan(0);
    expect(r.memory.used).toBe(r.memory.total - r.memory.free);
    expect(r.memory.usage).toBeGreaterThanOrEqual(0);
    expect(r.memory.usage).toBeLessThanOrEqual(1);
  });
});
