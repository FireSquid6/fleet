import { CovenantServer, emptyServerToSidekick } from "@covenant-rpc/server";
import { covenant } from "@/covenant";
import defineProjects from "./implementations/projects";
import defineTasks from "./implementations/tasks";
import defineAgents from "./implementations/agents";

const server = new CovenantServer(covenant, {
  contextGenerator: () => null,
  derivation: () => null,
  sidekickConnection: emptyServerToSidekick(),
  logLevel: "debug",
});

defineProjects();
defineTasks();
defineAgents();

export { server };
