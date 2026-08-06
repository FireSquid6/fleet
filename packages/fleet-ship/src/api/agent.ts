import { Elysia, t } from "elysia";
import type { AgentBridgeCredentialStore } from "../agent-credentials";
import { mapErrorHook } from "./http";

export const NO_BRIDGE_CREDENTIAL_ERROR =
  "this ship has no bridge credential yet; a bridge pushes one when it connects";

export function agentPlugin(store: AgentBridgeCredentialStore) {
  return new Elysia({ name: "ship-agent" })
    .onError(mapErrorHook)
    .get("/agent/credentials", ({ set }) => {
      const credential = store.get();
      if (credential === undefined) {
        set.status = 503;
        return { error: NO_BRIDGE_CREDENTIAL_ERROR };
      }
      return credential;
    })
    .post(
      "/agent/credentials",
      ({ body }) => {
        store.set(body);
        return { ok: true as const };
      },
      { body: t.Object({ bridgeUrl: t.String(), token: t.String() }) },
    );
}
