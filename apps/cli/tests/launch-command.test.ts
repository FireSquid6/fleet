import { describe, expect, test } from "bun:test";
import { planRegistrations, shipUrl, type RosterEntry } from "../src/launch-command";
import type { NormalizedShip } from "../src/launch-config";

const local = (key: string, port: number, name = key): NormalizedShip => ({
  key,
  source: "local",
  name,
  fleetDirectory: `/fleet/${key}`,
  port,
});

const remote = (key: string, url: string): NormalizedShip => ({ key, source: "remote", url });

const on = (name: string, url: string): RosterEntry => ({ name, url });

const skips = (ships: NormalizedShip[], roster: RosterEntry[] = []) =>
  planRegistrations(ships, roster).map((entry) => entry.skip);

describe("shipUrl", () => {
  test("a local ship is reached on localhost at its port", () => {
    expect(shipUrl(local("ship-a", 4700))).toBe("http://localhost:4700");
  });

  test("a remote ship is reached at its configured url", () => {
    expect(shipUrl(remote("ship-b", "http://another-host:4700"))).toBe("http://another-host:4700");
  });
});

describe("planRegistrations", () => {
  test("registers a ship the bridge does not have", () => {
    const plan = planRegistrations([local("ship-a", 4700)], []);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.url).toBe("http://localhost:4700");
    expect(plan[0]!.skip).toBeNull();
  });

  test("skips a local ship the bridge already holds under the same name and url", () => {
    expect(skips([local("ship-a", 4700)], [on("ship-a", "http://localhost:4700")])).toEqual(["on-bridge"]);
  });

  test("a trailing slash on the roster url still counts as registered", () => {
    expect(skips([local("ship-a", 4700)], [on("ship-a", "http://localhost:4700/")])).toEqual(["on-bridge"]);
  });

  test("a schemeless or bare-port roster url still counts as registered", () => {
    expect(skips([local("ship-a", 4700)], [on("ship-a", "localhost:4700")])).toEqual(["on-bridge"]);
    expect(skips([local("ship-a", 4700)], [on("ship-a", "4700")])).toEqual(["on-bridge"]);
  });

  test("a local ship whose name is on the roster at another url is skipped, reporting the roster url", () => {
    const plan = planRegistrations([local("ship-a", 47105)], [on("ship-a", "http://localhost:47101")]);
    expect(plan[0]!.skip).toBe("on-bridge-stale-url");
    expect(plan[0]).toMatchObject({ url: "http://localhost:47105", rosterUrl: "http://localhost:47101" });
  });

  test("a local ship whose url is on the roster under another name is still registered", () => {
    expect(skips([local("ship-a", 4700, "beta")], [on("alpha", "http://localhost:4700")])).toEqual([null]);
  });

  test("a remote ship matches on url alone, whatever the roster calls it", () => {
    expect(skips([remote("ship-b", "http://host-b:4700")], [on("anything", "http://host-b:4700/")])).toEqual([
      "on-bridge",
    ]);
  });

  test("a remote ship absent from the roster is registered", () => {
    expect(skips([remote("ship-c", "http://host-c:4700")], [on("ship-c", "http://host-b:4700")])).toEqual([null]);
  });

  test("two config entries on the same url produce one registration", () => {
    const plan = planRegistrations(
      [remote("ship-b", "http://host-b:4700"), remote("ship-b-again", "http://host-b:4700/")],
      [],
    );
    expect(plan.map((entry) => entry.skip)).toEqual([null, "duplicate-config-entry"]);
    expect(plan[1]).toMatchObject({ firstKey: "ship-b" });
  });

  test("a duplicate config entry is distinguishable from one the bridge already holds", () => {
    const plan = planRegistrations(
      [local("ship-a", 4700), remote("dupe", "http://localhost:4700/")],
      [on("ship-a", "http://localhost:4700")],
    );
    expect(plan.map((entry) => entry.skip)).toEqual(["on-bridge", "duplicate-config-entry"]);
  });

  test("duplicate config entries on an unregistered url do not claim the bridge holds it", () => {
    const plan = planRegistrations([remote("x", "http://dead:4700"), remote("y", "http://dead:4700")], []);
    expect(plan.map((entry) => entry.skip)).toEqual([null, "duplicate-config-entry"]);
  });

  test("distinct ports, names and hosts are all registered", () => {
    const ships = [local("ship-a", 4700), local("ship-b", 4701), remote("ship-c", "http://host-c:4700")];
    expect(skips(ships, [on("ship-d", "http://host-d:4700")])).toEqual([null, null, null]);
  });

  test("preserves config order and carries the ship through untouched", () => {
    const ships = [local("ship-a", 4700), remote("ship-b", "http://host-b:4700")];
    expect(planRegistrations(ships, []).map((entry) => entry.ship)).toEqual(ships);
  });

  test("an empty config plans nothing", () => {
    expect(planRegistrations([], [on("ship-a", "http://localhost:4700")])).toEqual([]);
  });
});
