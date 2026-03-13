import path from "path";
import os from "os";
import { Command } from "@commander-js/extra-typings";
import { startServer } from "./backend";
import { clientCommand } from "./cli/client";
import { initCommand } from "./cli/init";

const serveCommand = new Command()
  .name("serve")
  .option("-p, --port [port]", "port to listen on", "4456")
  .option("-d, --dir [dir]", "store directory. Defaults to ~/autosmith")
  .action(({ port: portString, dir }) => {
    const port = typeof portString === "string" ? parseInt(portString) : 4456;

    const defaultAutosmithDir = path.join(os.homedir(), "autosmith");
    const storeDirectory = typeof dir === "string" ? dir : defaultAutosmithDir;
    startServer({ port, storeDirectory });
  });

const mainCommand = new Command();
mainCommand.addCommand(serveCommand);
mainCommand.addCommand(clientCommand);
mainCommand.addCommand(initCommand);
mainCommand.parse();
