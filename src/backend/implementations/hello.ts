import { server } from "../server";

export default function defineHello() {
  server.defineProcedure("testHello", {
    procedure(i) {
      return { message: `Hello, ${i.inputs.name}`};
    },
    resources(i) {
      return [`/messages/${i.inputs.name}`];
    },
  });
}
