import { generateText, tool, stepCountIs, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { readdir, unlink } from "node:fs/promises";
import { Glob } from "bun";
import readline from "readline";

const filesystemTools = {
  readFile: tool({
    description: "Read the contents of a file at the given path",
    inputSchema: z.object({
      path: z.string().describe("Path to the file"),
    }),
    execute: async ({ path }) => {
      const file = Bun.file(path);
      if (!(await file.exists())) return `Error: File not found: ${path}`;
      return await file.text();
    },
  }),

  writeFile: tool({
    description: "Write content to a file, creating it or overwriting if it exists",
    inputSchema: z.object({
      path: z.string().describe("Path to the file"),
      content: z.string().describe("Content to write"),
    }),
    execute: async ({ path, content }) => {
      await Bun.write(path, content);
      return `Successfully wrote to ${path}`;
    },
  }),

  listDirectory: tool({
    description: "List the contents of a directory",
    inputSchema: z.object({
      path: z.string().describe("Path to the directory"),
    }),
    execute: async ({ path }) => {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? "dir" : "file"}: ${e.name}`).join("\n");
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  }),

  searchFiles: tool({
    description: "Search for files matching a glob pattern",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/*.json')"),
      directory: z.string().optional().describe("Directory to search in (defaults to current directory)"),
    }),
    execute: async ({ pattern, directory = "." }) => {
      const glob = new Glob(pattern);
      const matches: string[] = [];
      for await (const match of glob.scan({ cwd: directory, absolute: false })) {
        matches.push(match);
      }
      return matches.length > 0 ? matches.join("\n") : "No files found";
    },
  }),

  deleteFile: tool({
    description: "Delete a file at the given path",
    inputSchema: z.object({
      path: z.string().describe("Path to the file to delete"),
    }),
    execute: async ({ path }) => {
      try {
        await unlink(path);
        return `Successfully deleted ${path}`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  }),
};

export async function runAgent() {
  const messages: ModelMessage[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const getUserInput = (prompt: string): Promise<string | null> =>
    new Promise((resolve) => {
      const onClose = () => resolve(null);
      rl.once("close", onClose);
      rl.question(prompt, (answer) => {
        rl.removeListener("close", onClose);
        resolve(answer.trim() || null);
      });
    });

  console.log("Agent ready. Type your message (or 'exit' to quit).\n");

  while (true) {
    const input = await getUserInput("You: ");

    if (input === null || input.toLowerCase() === "exit") {
      console.log("Goodbye.");
      rl.close();
      break;
    }

    messages.push({ role: "user", content: input });

    try {
      const result = await generateText({
        model: anthropic("claude-sonnet-4-5"),
        system: "You are a helpful coding assistant with filesystem access. Use the provided tools to read, write, search, and manage files as needed.",
        tools: filesystemTools,
        stopWhen: stepCountIs(10),
        messages,
      });

      console.log(`\nAssistant: ${result.text}\n`);

      // ResponseMessage (AssistantModelMessage | ToolModelMessage) is a subset of ModelMessage
      messages.push(...(result.response.messages as ModelMessage[]));
    } catch (e) {
      console.error(`Error: ${(e as Error).message}\n`);
    }
  }
}
