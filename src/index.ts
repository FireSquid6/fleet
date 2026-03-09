import { Command } from "@commander-js/extra-typings";
import { startServer } from "./backend";

const serveCommand = new Command()
  .name("serve")
  .option("-p, --port [port]", "port to listen on", "4456")
  .option("-d, --dir [dir]", "store directory", "./fleet-data")
  .action(({ port: portString, dir }) => {
    const port = typeof portString === "string" ? parseInt(portString) : 4456;
    const storeDirectory = typeof dir === "string" ? dir : "./fleet-data";
    startServer({ port, storeDirectory });
  });

const mainCommand = new Command();
mainCommand.addCommand(serveCommand);
mainCommand.parse();
