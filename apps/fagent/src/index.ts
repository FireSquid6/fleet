#!/usr/bin/env bun
/**
 * index.ts — fagent CLI entry point.
 *
 * A standalone Commander.js CLI for fleet agents. It hosts the workspace
 * reporting operations (`fagent agent init|status|in-workspace`) that agents
 * run from inside a workspace to report their session and status back to the
 * ship, plus `fagent repo …` for repo operations routed through the bridge.
 */

import { Command } from "commander";
import { agentCommand } from "./agent-command";
import { repoCommand } from "./repo-command";

const mainCommand = new Command().name("fagent");

mainCommand.addCommand(agentCommand);
mainCommand.addCommand(repoCommand);

mainCommand.parseAsync(process.argv);
