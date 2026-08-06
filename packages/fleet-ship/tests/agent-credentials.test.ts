import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api";
import { generateAgentToken } from "../src/agent-credentials";
import { NO_BRIDGE_CREDENTIAL_ERROR } from "../src/api/agent";
import { stubConfig, stubManager } from "./helpers";

const BRIDGE_TOKEN = "bridge-secret";
const AGENT_TOKEN = "agent-secret";

function makeApp() {
  return createApp(
    stubManager(),
    { ...stubConfig, bridgeToken: BRIDGE_TOKEN, agentToken: AGENT_TOKEN },
    undefined,
    undefined,
    undefined,
    {},
  );
}

function push(app: ReturnType<typeof createApp>, credential: { bridgeUrl: string; token: string }) {
  return app.handle(
    new Request("http://ship/agent/credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(credential),
    }),
  );
}

function read(app: ReturnType<typeof createApp>) {
  return app.handle(
    new Request("http://ship/agent/credentials", { headers: { authorization: `Bearer ${AGENT_TOKEN}` } }),
  );
}

describe("agent bridge credentials", () => {
  test("serves an agent what the bridge pushed", async () => {
    const app = makeApp();
    const credential = { bridgeUrl: "http://bridge.test:4800", token: "ship-agent-token" };

    expect((await push(app, credential)).status).toBe(200);

    const response = await read(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(credential);
  });

  test("fails with 503 and a message when no bridge has pushed one", async () => {
    const response = await read(makeApp());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: NO_BRIDGE_CREDENTIAL_ERROR });
  });

  test("a later push replaces the credential in memory", async () => {
    const app = makeApp();
    await push(app, { bridgeUrl: "http://bridge.test:4800", token: "first" });
    await push(app, { bridgeUrl: "http://bridge.test:4800", token: "second" });

    expect(await (await read(app)).json()).toEqual({ bridgeUrl: "http://bridge.test:4800", token: "second" });
  });

  test("two ships do not share a credential", async () => {
    const one = makeApp();
    const two = makeApp();
    await push(one, { bridgeUrl: "http://bridge.test:4800", token: "for-one" });

    expect((await read(two)).status).toBe(503);
  });

  test("generateAgentToken is unguessable and fresh on every call", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateAgentToken()));

    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });
});
