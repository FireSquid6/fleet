import { Command } from "@commander-js/extra-typings";
import { startServer } from "./backend";


const mainCommand = new Command()
  .name("fleet")
  .action(() => {
    startServer({ port: 4456 });
  })



mainCommand.parse();
