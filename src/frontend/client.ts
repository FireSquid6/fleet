import { covenant } from "@/covenant";
import { CovenantClient, emptyClientToSidekick, httpClientToServer } from "@covenant-rpc/client";



export const covenantClient = new CovenantClient(covenant, {
  serverConnection: httpClientToServer("/", {}),
  sidekickConnection: emptyClientToSidekick(),
});
