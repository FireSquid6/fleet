import { tool } from "ai";
import { z } from "zod";
import type { Filesystem } from "../filesystem";

export function getToolkitFromFilesystem(fs: Filesystem) {
  return {
    fsReadFile: tool({
      description: "Read the contents of a file",
      inputSchema: z.object({
        path: z.string().describe("Path to the file, relative to the root"),
      }),
      execute: async ({ path }) => fs.readFile(path),
    }),

    fsWriteFile: tool({
      description: "Write content to a file, creating it if it doesn't exist",
      inputSchema: z.object({
        path: z.string().describe("Path to the file, relative to the root"),
        contents: z.string().describe("Content to write"),
      }),
      execute: async ({ path, contents }) => fs.writeFile(path, contents),
    }),

    fsEditFile: tool({
      description: "Replace an exact string in a file. Fails if the string is not found.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file, relative to the root"),
        oldString: z.string().describe("Exact string to find and replace"),
        newString: z.string().describe("String to replace it with"),
      }),
      execute: async ({ path, oldString, newString }) => fs.editFile(path, oldString, newString),
    }),

    fsDeleteFile: tool({
      description: "Delete a file",
      inputSchema: z.object({
        path: z.string().describe("Path to the file, relative to the root"),
      }),
      execute: async ({ path }) => fs.deleteFile(path),
    }),

    fsListDirectory: tool({
      description: "List the files and subdirectories in a directory",
      inputSchema: z.object({
        path: z.string().describe("Path to the directory, relative to the root"),
      }),
      execute: async ({ path }) => fs.listDirectory(path),
    }),

    fsSearchFiles: tool({
      description: "Find files matching a glob pattern (e.g. '**/*.ts', 'src/*.json')",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern to match file paths"),
        directory: z.string().optional().describe("Directory to search in (defaults to root)"),
      }),
      execute: async ({ pattern, directory }) => fs.searchFiles(pattern, directory),
    }),

    fsSearchContent: tool({
      description: "Search file contents for a regex pattern, returns matching lines with file and line number",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        directory: z.string().optional().describe("Directory to search in (defaults to root)"),
      }),
      execute: async ({ pattern, directory }) => fs.searchContent(pattern, directory),
    }),

    fsRunCommand: tool({
      description: "Run a bash command and return stdout, stderr, and exit code",
      inputSchema: z.object({
        command: z.string().describe("Bash command to run"),
        cwd: z.string().optional().describe("Working directory relative to root (defaults to root)"),
        timeoutMs: z.number().optional().describe("Timeout in milliseconds (default: 30000)"),
      }),
      execute: async ({ command, cwd, timeoutMs }) => fs.runCommand(command, { cwd, timeoutMs }),
    }),
  };
}
