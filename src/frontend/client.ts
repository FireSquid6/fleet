import { covenant } from "@/covenant";
import { CovenantReactClient } from "@covenant-rpc/react";
import { httpClientToServer } from "@covenant-rpc/client/interfaces/http";
import { emptyClientToSidekick } from "@covenant-rpc/client/interfaces/empty";

export const covenantClient = new CovenantReactClient(covenant, {
  serverConnection: httpClientToServer("/api/covenant", {}),
  sidekickConnection: emptyClientToSidekick(),
});
