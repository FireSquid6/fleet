import { describe, expect, test } from "bun:test";
import { AGENT_STATES } from "fleet-protocol";
import { AGENT_STATE_COLORS, agentStateColor } from "../src/lib/agent-status";

describe("agent status palette", () => {
  test("defines a distinct semantic color for every protocol state", () => {
    expect(Object.keys(AGENT_STATE_COLORS).sort()).toEqual([...AGENT_STATES].sort());
    expect(new Set(Object.values(AGENT_STATE_COLORS)).size).toBe(AGENT_STATES.length);
    for (const state of AGENT_STATES) expect(agentStateColor(state)).toBe(AGENT_STATE_COLORS[state]);
  });
});
