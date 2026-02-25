import { CovenantServer, emptyServerToSidekick } from "@covenant-rpc/server";
import { covenant } from "@/covenant";


export const server = new CovenantServer(covenant, {
  contextGenerator: () => null,
  derivation: () => null,
  sidekickConnection: emptyServerToSidekick(),
  logLevel: "debug",
});
