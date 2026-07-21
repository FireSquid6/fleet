import { describe, expect, test } from "bun:test";
// @ts-expect-error Bun imports this module's source text rather than its exports.
import pluginSource from "../plugins/opencode.js" with { type: "text" };

const pluginUrl = `data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`;
const { FleetAgentActivation } = (await import(pluginUrl)) as typeof import("../plugins/opencode.js");

function shellResult(exitCode: number, stdout: string) {
  return () => {
    const command = Promise.resolve({ exitCode, text: () => stdout });
    return Object.assign(command, {
      cwd: () => command,
      quiet: () => command,
      nothrow: () => command,
    });
  };
}

describe("OpenCode fleet-agent plugin", () => {
  test("invokes the fleet agent namespace", () => {
    expect(pluginSource).toContain("fleet agent in-workspace");
    expect(pluginSource).not.toContain("fleet-agent in-workspace");
  });

  test("does nothing when fleet is unavailable or outside a workspace", async () => {
    expect(
      await FleetAgentActivation({ $: shellResult(127, ""), directory: "/workspace" }),
    ).toEqual({});
    expect(
      await FleetAgentActivation({ $: shellResult(1, "no workspace\n"), directory: "/workspace" }),
    ).toEqual({});
  });

  test("does nothing for malformed successful output", async () => {
    expect(
      await FleetAgentActivation({ $: shellResult(0, "not-a-workspace\n"), directory: "/workspace" }),
    ).toEqual({});
  });

  test("instructs the agent to activate the skill in a fleet workspace", async () => {
    const hooks = await FleetAgentActivation({
      $: shellResult(0, "autosmith/worker-1\n"),
      directory: "/workspace",
    });
    const output = { system: [] as string[] };

    await hooks["experimental.chat.system.transform"]?.({}, output);

    expect(output.system).toEqual([
      "You are running inside fleet workspace autosmith/worker-1. Before doing any work, use the skill tool to activate the fleet-agent skill and follow its instructions for this session.",
    ]);
  });
});
