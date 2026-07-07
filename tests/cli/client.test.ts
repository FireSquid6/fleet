import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "../../apps/cli/src/client";

describe("normalizeUrl", () => {
  test("passes through a full http URL unchanged", () => {
    expect(normalizeUrl("http://localhost:4700")).toBe("http://localhost:4700");
  });

  test("passes through a full https URL unchanged", () => {
    expect(normalizeUrl("https://ship.example.com:4700")).toBe("https://ship.example.com:4700");
  });

  test("strips a trailing slash", () => {
    expect(normalizeUrl("http://localhost:4700/")).toBe("http://localhost:4700");
  });

  test("expands a bare port to localhost", () => {
    expect(normalizeUrl("4700")).toBe("http://localhost:4700");
  });

  test("prefixes a host:port with http://", () => {
    expect(normalizeUrl("localhost:4700")).toBe("http://localhost:4700");
  });

  test("prefixes a bare hostname with http://", () => {
    expect(normalizeUrl("myship.local")).toBe("http://myship.local");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeUrl("  localhost:4700  ")).toBe("http://localhost:4700");
  });
});
