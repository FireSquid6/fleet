#!/usr/bin/env bun

import { Command } from "commander";
import { agentCommand } from "./agent-command";
import { repoCommand } from "./repo-command";

const mainCommand = new Command().name("fagent");

mainCommand.addCommand(agentCommand);
mainCommand.addCommand(repoCommand);

mainCommand.parseAsync(process.argv);
