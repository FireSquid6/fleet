import { SidekickIntegratedCovenantServer } from "@covenant-rpc/sidekick-bun-adapter";
import { covenant } from "../covenant";
import { AutosmithStore } from "../store";
import { AgentManager } from "./agent-manager";
import { registerProjectProcedures } from "./procedures/projects";
import { registerUserProcedures } from "./procedures/user";
import { registerAgentProcedures } from "./procedures/agents";
import { registerLifecycleProcedures } from "./procedures/lifecycle";
import { registerContentProcedures } from "./procedures/content";
import { registerAgentSessionChannel } from "./channels/agent-session";

export async function createServer(storeDirectory: string) {
  const store = new AutosmithStore(storeDirectory);
  const agents = new AgentManager(store);
  await store.initialize();

  const server = new SidekickIntegratedCovenantServer(covenant, {
    contextGenerator: () => null,
    derivation: () => null,
    logLevel: "info",
  });

  registerUserProcedures(server, store);
  registerProjectProcedures(server, store);
  registerAgentProcedures(server, store);
  registerLifecycleProcedures(server, agents, store);
  registerContentProcedures(server, store);
  registerAgentSessionChannel(server, agents);

  server.assertAllDefined();

  return { server, store, agents };
}
