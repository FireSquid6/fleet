import { describe, expect, test } from "bun:test";
import { planRegistrations, shipUrl } from "../src/launch-command";
import type { NormalizedShip } from "../src/launch-config";

const local = (key: string, port: number): NormalizedShip => ({
  key,
  source: "local",
  name: key,
  fleetDirectory: `/fleet/${key}`,
  port,
});

const remote = (key: string, url: string): NormalizedShip => ({ key, source: "remote", url });

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
    expect(plan[0]!.alreadyRegistered).toBe(false);
  });

  test("skips a ship whose url is already in the bridge roster", () => {
    const plan = planRegistrations([local("ship-a", 4700)], ["http://localhost:4700"]);
    expect(plan[0]!.alreadyRegistered).toBe(true);
  });

  test("skips a remote ship already in the roster and keeps an absent one", () => {
    const plan = planRegistrations(
      [remote("ship-b", "http://host-b:4700"), remote("ship-c", "http://host-c:4700")],
      ["http://host-b:4700"],
    );
    expect(plan.map((entry) => [entry.ship.key, entry.alreadyRegistered])).toEqual([
      ["ship-b", true],
      ["ship-c", false],
    ]);
  });

  test("a trailing slash on the roster url still counts as registered", () => {
    const plan = planRegistrations([local("ship-a", 4700)], ["http://localhost:4700/"]);
    expect(plan[0]!.alreadyRegistered).toBe(true);
  });

  test("a schemeless or bare-port roster url still counts as registered", () => {
    expect(planRegistrations([local("ship-a", 4700)], ["localhost:4700"])[0]!.alreadyRegistered).toBe(true);
    expect(planRegistrations([local("ship-a", 4700)], ["4700"])[0]!.alreadyRegistered).toBe(true);
  });

  test("two config entries on the same url produce one registration", () => {
    const plan = planRegistrations(
      [remote("ship-b", "http://host-b:4700"), remote("ship-b-again", "http://host-b:4700/")],
      [],
    );
    expect(plan.map((entry) => entry.alreadyRegistered)).toEqual([false, true]);
  });

  test("a local ship and a remote entry pointing at it collapse to one registration", () => {
    const plan = planRegistrations([local("ship-a", 4700), remote("dupe", "http://localhost:4700/")], []);
    expect(plan.map((entry) => entry.alreadyRegistered)).toEqual([false, true]);
  });

  test("distinct ports and hosts are all registered", () => {
    const plan = planRegistrations(
      [local("ship-a", 4700), local("ship-b", 4701), remote("ship-c", "http://host-c:4700")],
      ["http://host-d:4700"],
    );
    expect(plan.map((entry) => entry.alreadyRegistered)).toEqual([false, false, false]);
  });

  test("preserves config order and carries the ship through untouched", () => {
    const ships = [local("ship-a", 4700), remote("ship-b", "http://host-b:4700")];
    const plan = planRegistrations(ships, []);
    expect(plan.map((entry) => entry.ship)).toEqual(ships);
  });

  test("an empty config plans nothing", () => {
    expect(planRegistrations([], ["http://localhost:4700"])).toEqual([]);
  });
});
