import { CovenantServer, emptyServerToSidekick } from "@covenant-rpc/server";
import { covenant } from "@/covenant";
import defineHello from "./implementations/hello";

const server = new CovenantServer(covenant, {
  contextGenerator: () => null,
  derivation: () => null,
  sidekickConnection: emptyServerToSidekick(),
  logLevel: "debug",
});


defineHello();



export { server };
