import { describe, expect, test } from "bun:test";
import {
  REGISTER_BRIDGE_TOKEN_ENV_VAR,
  REGISTER_SHIP_TOKEN_ENV_VAR,
  resolveShipRegistrationTokens,
} from "../src/ship-tokens";

function recordingPrompt(answers: string[]) {
  const asked: string[] = [];
  const promptSecret = async (question: string) => {
    asked.push(question);
    return answers.shift() ?? "";
  };
  return { asked, promptSecret };
}

describe("resolveShipRegistrationTokens", () => {
  test("reads both tokens from the environment without prompting", async () => {
    const { asked, promptSecret } = recordingPrompt([]);
    const tokens = await resolveShipRegistrationTokens({
      env: { [REGISTER_SHIP_TOKEN_ENV_VAR]: "s", [REGISTER_BRIDGE_TOKEN_ENV_VAR]: "b" },
      isTty: true,
      promptSecret,
    });

    expect(tokens).toEqual({ shipToken: "s", bridgeToken: "b" });
    expect(asked).toEqual([]);
  });

  test("registers without credentials in a script when the environment is empty", async () => {
    const { asked, promptSecret } = recordingPrompt(["never asked"]);
    const tokens = await resolveShipRegistrationTokens({ env: {}, isTty: false, promptSecret });

    expect(tokens).toEqual({ shipToken: undefined, bridgeToken: undefined });
    expect(asked).toEqual([]);
  });

  test("prompts for both tokens at a terminal", async () => {
    const { asked, promptSecret } = recordingPrompt(["  ship-token  ", "bridge-token"]);
    const tokens = await resolveShipRegistrationTokens({ env: {}, isTty: true, promptSecret });

    expect(tokens).toEqual({ shipToken: "ship-token", bridgeToken: "bridge-token" });
    expect(asked).toHaveLength(2);
  });

  test("a blank ship token at the prompt means no credentials, and asks nothing further", async () => {
    const { asked, promptSecret } = recordingPrompt(["   ", "bridge-token"]);
    const tokens = await resolveShipRegistrationTokens({ env: {}, isTty: true, promptSecret });

    expect(tokens).toEqual({});
    expect(asked).toHaveLength(1);
  });

  test("a blank bridge token is left unset, so the bridge rejects the half pair", async () => {
    const { promptSecret } = recordingPrompt(["ship-token", ""]);
    const tokens = await resolveShipRegistrationTokens({ env: {}, isTty: true, promptSecret });

    expect(tokens).toEqual({ shipToken: "ship-token", bridgeToken: undefined });
  });

  test("an environment variable set to whitespace counts as unset", async () => {
    const { asked, promptSecret } = recordingPrompt(["prompted", "also-prompted"]);
    const tokens = await resolveShipRegistrationTokens({
      env: { [REGISTER_SHIP_TOKEN_ENV_VAR]: "   " },
      isTty: true,
      promptSecret,
    });

    expect(tokens).toEqual({ shipToken: "prompted", bridgeToken: "also-prompted" });
    expect(asked).toHaveLength(2);
  });

  test("one variable set is enough to suppress the prompt, leaving the bridge to reject it", async () => {
    const { asked, promptSecret } = recordingPrompt([]);
    const tokens = await resolveShipRegistrationTokens({
      env: { [REGISTER_BRIDGE_TOKEN_ENV_VAR]: "b" },
      isTty: true,
      promptSecret,
    });

    expect(tokens).toEqual({ shipToken: undefined, bridgeToken: "b" });
    expect(asked).toEqual([]);
  });
});
