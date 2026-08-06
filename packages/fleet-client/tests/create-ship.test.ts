import { describe, expect, test } from "bun:test";
import {
  SHIP_TOKEN_BYTES,
  createShipInput,
  generateShipToken,
  generateShipTokens,
  type CreateShipForm,
} from "../src/lib/create-ship";

const form = (patch: Partial<CreateShipForm> = {}): CreateShipForm => ({
  url: "http://ship-host:4700",
  shipToken: "",
  bridgeToken: "",
  ...patch,
});

describe("createShipInput", () => {
  test("a bare url registers a ship with no tokens", () => {
    expect(createShipInput(form())).toEqual({ url: "http://ship-host:4700" });
  });

  test("returns null when the url is blank", () => {
    expect(createShipInput(form({ url: "   " }))).toBeNull();
  });

  test("trims every field", () => {
    expect(createShipInput(form({ url: "  http://h:4700  ", shipToken: " s ", bridgeToken: " b " }))).toEqual({
      url: "http://h:4700",
      shipToken: "s",
      bridgeToken: "b",
    });
  });

  test("omits a blank token entirely rather than sending an empty string", () => {
    const input = createShipInput(form({ shipToken: "s", bridgeToken: "  " }));
    expect(input).toEqual({ url: "http://ship-host:4700", shipToken: "s" });
    expect(input).not.toHaveProperty("bridgeToken");
  });

  test("passes exactly one token through, leaving the both-or-neither rule to the bridge", () => {
    expect(createShipInput(form({ bridgeToken: "b" }))).toEqual({
      url: "http://ship-host:4700",
      bridgeToken: "b",
    });
  });
});

describe("generateShipToken", () => {
  test("is base64url of SHIP_TOKEN_BYTES bytes, unpadded", () => {
    const token = generateShipToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(Math.ceil((SHIP_TOKEN_BYTES * 8) / 6));
  });

  test("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateShipToken()));
    expect(tokens.size).toBe(64);
  });

  test("round-trips through base64url decoding to the requested byte count", () => {
    const token = generateShipToken(16);
    const padded = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
    expect(atob(padded)).toHaveLength(16);
  });
});

describe("generateShipTokens", () => {
  test("mints two distinct tokens", () => {
    const { shipToken, bridgeToken } = generateShipTokens();
    expect(shipToken).not.toBe(bridgeToken);
    expect(shipToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bridgeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
