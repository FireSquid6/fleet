#!/usr/bin/env bun
/**
 * index.ts — fagent CLI entry point.
 *
 * A standalone Commander.js CLI for fleet agents. It hosts the workspace
 * reporting operations (`fagent agent init|status|in-workspace`) that agents
 * run from inside a workspace to report their session and status back to the
 * ship. A `repo` subcommand lands in a later step.
 */

import { Command } from "commander";
import { agentCommand } from "./agent-command";

const mainCommand = new Command().name("fagent");

mainCommand.addCommand(agentCommand);
// Future: mainCommand.addCommand(repoCommand);

mainCommand.parseAsync(process.argv);
