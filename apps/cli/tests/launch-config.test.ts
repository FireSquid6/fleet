import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { resolve } from "node:path";
import { CONFIG_TEMPLATE, parseLaunchConfig } from "../src/launch-config";

describe("parseLaunchConfig", () => {
  test("normalizes a full config (bridge + gui + local & remote ships)", () => {
    const config = parseLaunchConfig({
      bridge: { dataDirectory: "./bridge-data", port: 4800, name: "b" },
      gui: { port: 3000 },
      ships: {
        "ship-a": { source: "local", fleetDirectory: "./fleet/a", port: 4700, name: "ship-a" },
        "ship-b": { source: "remote", url: "http://host:4700" },
      },
    });

    expect(config.bridge).toEqual({ dataDirectory: resolve("./bridge-data"), port: 4800, name: "b" });
    expect(config.gui).toEqual({ port: 3000 });
    expect(config.ships).toEqual([
      { key: "ship-a", source: "local", name: "ship-a", fleetDirectory: resolve("./fleet/a"), port: 4700 },
      { key: "ship-b", source: "remote", url: "http://host:4700" },
    ]);
  });

  test("every section is optional", () => {
    expect(parseLaunchConfig({})).toEqual({ bridge: undefined, gui: undefined, ships: [] });
    const shipsOnly = parseLaunchConfig({ ships: { "ship-a": { source: "local", port: 4700 } } });
    expect(shipsOnly.bridge).toBeUndefined();
    expect(shipsOnly.gui).toBeUndefined();
    expect(shipsOnly.ships).toHaveLength(1);
  });

  test("ships default source to local and derive name/fleetDirectory from the key", () => {
    const config = parseLaunchConfig({ ships: { "ship-a": {} } });
    expect(config.ships[0]).toEqual({
      key: "ship-a",
      source: "local",
      name: "ship-a",
      fleetDirectory: resolve("./fleet/ship-a"),
      port: 4700,
    });
  });

  test("bridge section fills defaults when fields are omitted", () => {
    const config = parseLaunchConfig({ bridge: {} });
    expect(config.bridge).toEqual({ dataDirectory: resolve("./.fleet/bridge"), port: 4800, name: "bridge" });
  });

  test("remote ships require a url", () => {
    expect(() => parseLaunchConfig({ ships: { "ship-a": { source: "remote" } } })).toThrow();
  });

  test("rejects two local ships sharing a port", () => {
    expect(() =>
      parseLaunchConfig({
        ships: {
          "ship-a": { source: "local", port: 4700 },
          "ship-b": { source: "local", port: 4700 },
        },
      }),
    ).toThrow(/port 4700/);
  });

  test("rejects a gui with no bridge and no bridgeUrl", () => {
    expect(() => parseLaunchConfig({ gui: { port: 3000 } })).toThrow(/gui/);
  });

  test("allows a gui with an explicit bridgeUrl and no bridge", () => {
    const config = parseLaunchConfig({ gui: { bridgeUrl: "http://host:4800" } });
    expect(config.bridge).toBeUndefined();
    expect(config.gui).toEqual({ bridgeUrl: "http://host:4800" });
  });

  test("the init scaffold is a valid config", () => {
    const config = parseLaunchConfig(parse(CONFIG_TEMPLATE));
    expect(config.bridge?.name).toBe("my-fleet-bridge");
    expect(config.gui?.port).toBe(3000);
    expect(config.ships).toEqual([
      { key: "ship-a", source: "local", name: "ship-a", fleetDirectory: resolve("./fleet/ship-a"), port: 4700 },
    ]);
  });
});
