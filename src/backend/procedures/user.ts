import type { AppServer } from "../server-types";
import type { AutosmithStore } from "../../store";

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
}
