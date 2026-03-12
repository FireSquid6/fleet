import type { AppServer } from "../server-types";
import type { AutosmithStore } from "../../store";
import { exec } from "node:child_process";

export function registerUserProcedures(server: AppServer, store: AutosmithStore) {
  server.defineProcedure("getUser", {
    resources: () => ["user"],
    procedure: () => store.getUser(),
  });

  server.defineProcedure("updateUser", {
    resources: () => ["user"],
    procedure: async ({ inputs }) => {
      await store.updateUser(inputs);
      return null;
    },
  });

  server.defineProcedure("openAgentWorkspace", {
    resources: () => [],
    procedure: async ({ inputs }): Promise<"opened" | "failed"> => {
      const directory = store.agentWorkspacePath(inputs.project, inputs.agent);
      console.log(directory);
      const user = await store.getUser();
      const commandTemplate = user.openCommand;

      if (commandTemplate === undefined) {
        return "failed";
      }

      // WARNING - if we ever make this a "multi tenant" application
      // where we aren't assuming that the app is just one user on their
      // own machine, this could allow arbitrary commands with special
      // injections from agent/project names
      //
      // this isn't an issue though since the user running the process
      // already has arbitrary command pribilidges.
      const command = commandTemplate.replaceAll("{dirpath}", directory);
      exec(command);

      return "opened";
    },
  })
}
