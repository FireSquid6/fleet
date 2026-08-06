import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { resolve } from "node:path";
import { CONFIG_TEMPLATE, parseLaunchConfig, publicUrlWarning } from "../src/launch-config";

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

  test("rejects two local ships sharing a name", () => {
    expect(() =>
      parseLaunchConfig({
        ships: {
          primary: { source: "local", port: 4700, name: "workhorse" },
          secondary: { source: "local", port: 4701, name: "workhorse" },
        },
      }),
    ).toThrow(/ships "primary" and "secondary" both use the name "workhorse"/);
  });

  test("distinct explicit names on distinct ports are fine", () => {
    const config = parseLaunchConfig({
      ships: {
        primary: { source: "local", port: 4700, name: "workhorse" },
        secondary: { source: "local", port: 4701, name: "packhorse" },
      },
    });
    expect(config.ships.map((ship) => ship.source === "local" && ship.name)).toEqual([
      "workhorse",
      "packhorse",
    ]);
  });

  test("rejects a gui with no bridge and no bridgeUrl", () => {
    expect(() => parseLaunchConfig({ gui: { port: 3000 } })).toThrow(/gui/);
  });

  test("allows a gui with an explicit bridgeUrl and no bridge", () => {
    const config = parseLaunchConfig({ gui: { bridgeUrl: "http://host:4800" } });
    expect(config.bridge).toBeUndefined();
    expect(config.gui).toEqual({ bridgeUrl: "http://host:4800" });
  });

  test("bridge carries an explicit publicUrl through unchanged", () => {
    const config = parseLaunchConfig({ bridge: { publicUrl: "http://control.internal:4800" } });
    expect(config.bridge).toEqual({
      dataDirectory: resolve("./.fleet/bridge"),
      port: 4800,
      name: "bridge",
      publicUrl: "http://control.internal:4800",
    });
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

describe("bridge.insecureNoAuth", () => {
  test("carries through when set", () => {
    const config = parseLaunchConfig({ bridge: { insecureNoAuth: true } });
    expect(config.bridge?.insecureNoAuth).toBe(true);
  });

  test("is absent rather than false when omitted", () => {
    const config = parseLaunchConfig({ bridge: {} });
    expect(config.bridge?.insecureNoAuth).toBeUndefined();
  });

  test("rejects a non-boolean", () => {
    expect(() => parseLaunchConfig({ bridge: { insecureNoAuth: "yes" } })).toThrow();
  });
});

describe("ship tokens", () => {
  const env = { SHIP_A_SHIP: "s-from-env", SHIP_A_BRIDGE: "b-from-env", BLANK: "   " };

  test("literal tokens are carried through on local and remote ships", () => {
    const config = parseLaunchConfig(
      {
        ships: {
          "ship-a": { shipToken: "s-a", bridgeToken: "b-a" },
          "ship-b": { source: "remote", url: "http://host:4700", shipToken: "s-b", bridgeToken: "b-b" },
        },
      },
      { env: {} },
    );

    expect(config.ships[0]).toMatchObject({ key: "ship-a", shipToken: "s-a", bridgeToken: "b-a" });
    expect(config.ships[1]).toMatchObject({ key: "ship-b", shipToken: "s-b", bridgeToken: "b-b" });
  });

  test("${VAR} resolves from the injected environment", () => {
    const config = parseLaunchConfig(
      { ships: { "ship-a": { shipToken: "${SHIP_A_SHIP}", bridgeToken: "${SHIP_A_BRIDGE}" } } },
      { env },
    );

    expect(config.ships[0]).toMatchObject({ shipToken: "s-from-env", bridgeToken: "b-from-env" });
  });

  test("surrounding whitespace in the reference and in the value is ignored", () => {
    const config = parseLaunchConfig(
      { ships: { "ship-a": { shipToken: " ${SHIP_A_SHIP} ", bridgeToken: "${SHIP_A_BRIDGE}" } } },
      { env: { SHIP_A_SHIP: " s-from-env\n", SHIP_A_BRIDGE: "b-from-env" } },
    );

    expect(config.ships[0]).toMatchObject({ shipToken: "s-from-env", bridgeToken: "b-from-env" });
  });

  test("an unset variable fails the launch rather than registering an unauthenticated ship", () => {
    expect(() =>
      parseLaunchConfig(
        { ships: { "ship-a": { shipToken: "${MISSING}", bridgeToken: "${SHIP_A_BRIDGE}" } } },
        { env },
      ),
    ).toThrow(/ships\."ship-a"\.shipToken is \$\{MISSING\}, which is unset or empty/);
  });

  test("a variable set to whitespace counts as unset", () => {
    expect(() =>
      parseLaunchConfig({ ships: { "ship-a": { shipToken: "${BLANK}", bridgeToken: "b" } } }, { env }),
    ).toThrow(/unset or empty/);
  });

  test("a partial interpolation is rejected rather than taken literally", () => {
    expect(() =>
      parseLaunchConfig({ ships: { "ship-a": { shipToken: "tok-${SHIP_A_SHIP}", bridgeToken: "b" } } }, { env }),
    ).toThrow(/is not exactly one \$\{VAR\} reference/);
  });

  test("rejects one token without the other", () => {
    expect(() => parseLaunchConfig({ ships: { "ship-a": { shipToken: "s" } } }, { env: {} })).toThrow(
      /ship "ship-a" sets shipToken but not bridgeToken/,
    );
    expect(() =>
      parseLaunchConfig({ ships: { "ship-b": { source: "remote", url: "http://h:4700", bridgeToken: "b" } } }, { env: {} }),
    ).toThrow(/ship "ship-b" sets bridgeToken but not shipToken/);
  });

  test("rejects an empty token string", () => {
    expect(() => parseLaunchConfig({ ships: { "ship-a": { shipToken: "", bridgeToken: "b" } } }, { env: {} })).toThrow();
  });

  test("ships without tokens are unchanged", () => {
    const config = parseLaunchConfig({ ships: { "ship-a": {} } }, { env });
    expect(config.ships[0]).toEqual({
      key: "ship-a",
      source: "local",
      name: "ship-a",
      fleetDirectory: resolve("./fleet/ship-a"),
      port: 4700,
    });
  });
});

describe("publicUrlWarning", () => {
  const remoteConfig = (bridge: Record<string, unknown>) =>
    parseLaunchConfig({
      bridge,
      ships: {
        "ship-a": { source: "remote", url: "http://a:4700" },
        "ship-b": { source: "remote", url: "http://b:4700" },
      },
    });

  test("warns when remote ships are registered with no publicUrl", () => {
    const warning = publicUrlWarning(remoteConfig({ port: 4800 }));
    expect(warning).toContain('remote ships "ship-a", "ship-b"');
    expect(warning).toContain("http://localhost:4800");
    expect(warning).toContain("set bridge.publicUrl");
  });

  test("uses the singular for one remote ship", () => {
    const config = parseLaunchConfig({
      bridge: {},
      ships: { "ship-a": { source: "remote", url: "http://a:4700" } },
    });
    expect(publicUrlWarning(config)).toContain('remote ship "ship-a"');
  });

  test("stays quiet once publicUrl is set", () => {
    expect(publicUrlWarning(remoteConfig({ publicUrl: "http://control:4800" }))).toBeNull();
  });

  test("stays quiet with only local ships", () => {
    const config = parseLaunchConfig({ bridge: {}, ships: { "ship-a": {} } });
    expect(publicUrlWarning(config)).toBeNull();
  });

  test("stays quiet with no bridge to reach", () => {
    const config = parseLaunchConfig({ ships: { "ship-a": { source: "remote", url: "http://a:4700" } } });
    expect(publicUrlWarning(config)).toBeNull();
  });
});
