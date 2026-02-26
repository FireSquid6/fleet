import { covenant } from "@/covenant";
import { CovenantReactClient } from "@covenant-rpc/react";
import { httpClientToServer } from "@covenant-rpc/client/interfaces/http";
import { emptyClientToSidekick } from "@covenant-rpc/client/interfaces/empty";


const url = `${window.location.protocol}//${window.location.host}/api/covenant`
export const covenantClient = new CovenantReactClient(covenant, {
  serverConnection: httpClientToServer(url, {}),
  sidekickConnection: emptyClientToSidekick(),
});
