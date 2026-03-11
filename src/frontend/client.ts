import { CovenantReactClient } from "@covenant-rpc/react";
import { httpClientToServer } from "@covenant-rpc/client/interfaces/http";
import { httpClientToSidekick } from "@covenant-rpc/client/interfaces/http";
import { covenant } from "../covenant";

const sidekickUrl = `${window.location.origin}/socket`;
const covenantUrl = `${window.location.origin}/api/covenant`;

export const client = new CovenantReactClient(covenant, {
  serverConnection: httpClientToServer(covenantUrl, {}),
  sidekickConnection: httpClientToSidekick(sidekickUrl),
});
