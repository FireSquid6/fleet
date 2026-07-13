import { describe, expect, test } from "bun:test";
import {
  FleetEventSchema,
  decodeFleetEvent,
  type FleetEvent,
  type WorkspaceSummary,
} from "fleet-protocol";

const summary: WorkspaceSummary = { repoName: "Hello-World", name: "ws1", branch: "main", active: true };

const samples: FleetEvent[] = [
  { type: "sync", ship: "ship-a", at: "2026-07-06T00:00:00.000Z", workspaces: [summary] },
  { type: "workspace.created", ship: "ship-a", at: "2026-07-06T00:00:00.000Z", workspace: { ...summary, active: false } },
  { type: "workspace.branch_changed", ship: "ship-a", at: "2026-07-06T00:00:00.000Z", workspace: summary },
  { type: "workspace.activated", ship: "ship-a", at: "2026-07-06T00:00:00.000Z", workspace: summary },
  { type: "workspace.deactivated", ship: "ship-a", at: "2026-07-06T00:00:00.000Z", workspace: { ...summary, active: false } },
  { type: "workspace.removed", ship: "ship-a", at: "2026-07-06T00:00:00.000Z", workspace: { ...summary, active: false } },
];

describe("FleetEventSchema", () => {
  test("every event type round-trips through decodeFleetEvent (as JSON)", () => {
    for (const event of samples) {
      const decoded = decodeFleetEvent(JSON.stringify(event));
      expect(decoded).toEqual(event);
    }
  });

  test("decodeFleetEvent also accepts an already-parsed object", () => {
    const decoded = decodeFleetEvent(samples[3]);
    expect(decoded.type).toBe("workspace.activated");
  });

  test("every event carries the ship name that emitted it", () => {
    for (const event of samples) {
      expect(typeof event.ship).toBe("string");
      expect(FleetEventSchema.parse(event).ship).toBe("ship-a");
    }
  });

  test("the sync event carries a workspaces snapshot", () => {
    const decoded = decodeFleetEvent(JSON.stringify(samples[0]));
    expect(decoded.type).toBe("sync");
    if (decoded.type === "sync") {
      expect(decoded.workspaces).toEqual([summary]);
    }
  });

  test("rejects an unknown event type", () => {
    expect(() => decodeFleetEvent(JSON.stringify({ type: "workspace.exploded", ship: "s", at: "t" }))).toThrow();
  });

  test("rejects an event missing the ship field", () => {
    expect(() => decodeFleetEvent(JSON.stringify({ type: "workspace.activated", at: "t", workspace: summary }))).toThrow();
  });

  test("rejects a change event with a malformed workspace summary", () => {
    expect(() =>
      decodeFleetEvent(
        JSON.stringify({ type: "workspace.activated", ship: "s", at: "t", workspace: { repo: "x" } }),
      ),
    ).toThrow();
  });
});
