import { Command } from "@commander-js/extra-typings";
import { startServer } from "./backend";
import { runAgent } from "./backend/agent";

const serveCommand = new Command()
  .name("serve")
  .option("-p, --port [port]")
  .action(({ port: portString }) => {
    const port = typeof portString === "string" ? parseInt(portString) : 4456
    startServer({ port });
  })

const agentCommand = new Command()
  .name("agent")
  .action(() => {
    runAgent();
  })


const mainCommand = new Command()
mainCommand.addCommand(serveCommand)
mainCommand.addCommand(agentCommand)

mainCommand.parse();
