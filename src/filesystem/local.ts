import { join, resolve, relative } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { Glob } from "bun";
import type { Filesystem, DirectoryEntry, ContentMatch, CommandResult, ProcessHandle } from "./index";

export class LocalFilesystem implements Filesystem {
  private root: string;
  private processes = new Map<string, ReturnType<typeof Bun.spawn>>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  getType(): string {
    return "local";
  }

  getRootPath(): string {
    return this.root;
  }

  // Resolves a user-provided path to an absolute path and ensures it stays
  // within the root to prevent directory traversal.
  private resolveSafe(path: string): string {
    const abs = resolve(join(this.root, path));
    if (!abs.startsWith(this.root + "/") && abs !== this.root) {
      throw new Error(`Access denied: path is outside root (${path})`);
    }
    return abs;
  }

  async readFile(path: string): Promise<string> {
    return Bun.file(this.resolveSafe(path)).text();
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await Bun.write(this.resolveSafe(path), contents);
  }

  async editFile(path: string, oldString: string, newString: string): Promise<void> {
    const abs = this.resolveSafe(path);
    const contents = await Bun.file(abs).text();
    if (!contents.includes(oldString)) {
      throw new Error(`Edit failed: string not found in ${path}`);
    }
    await Bun.write(abs, contents.replace(oldString, newString));
  }

  async deleteFile(path: string): Promise<void> {
    await unlink(this.resolveSafe(path));
  }

  async listDirectory(path: string): Promise<DirectoryEntry[]> {
    const entries = await readdir(this.resolveSafe(path), { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? "directory" : "file",
    }));
  }

  async searchFiles(pattern: string, directory?: string): Promise<string[]> {
    const cwd = directory ? this.resolveSafe(directory) : this.root;
    const glob = new Glob(pattern);
    const matches: string[] = [];
    for await (const match of glob.scan({ cwd, absolute: false })) {
      matches.push(match);
    }
    return matches;
  }

  async searchContent(pattern: string, directory?: string): Promise<ContentMatch[]> {
    const cwd = directory ? this.resolveSafe(directory) : this.root;
    const proc = Bun.spawn(["rg", "--line-number", "--no-heading", "--color=never", pattern], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (!output.trim()) return [];

    return output
      .trim()
      .split("\n")
      .map(line => {
        const [file = "", lineNum = "0", ...rest] = line.split(":");
        return {
          file: relative(this.root, join(cwd, file)),
          line: parseInt(lineNum),
          text: rest.join(":").trim(),
        };
      });
  }

  async startProcess(command: string, options?: { cwd?: string }): Promise<ProcessHandle> {
    const id = crypto.randomUUID();
    const cwd = options?.cwd ? this.resolveSafe(options.cwd) : this.root;
    const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
    this.processes.set(id, proc);
    return { id };
  }

  async stopProcess(handle: ProcessHandle): Promise<void> {
    const proc = this.processes.get(handle.id);
    if (!proc) throw new Error(`No process found with id: ${handle.id}`);
    proc.kill();
    this.processes.delete(handle.id);
  }

  async waitForPort(
    port: number,
    options?: { hostname?: string; timeoutMs?: number },
  ): Promise<void> {
    const hostname = options?.hostname ?? "localhost";
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const open = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host: hostname, port });
        socket.on("connect", () => { socket.destroy(); resolve(true); });
        socket.on("error", () => resolve(false));
      });
      if (open) return;
      await Bun.sleep(100);
    }

    throw new Error(`Port ${port} did not become available within ${timeoutMs}ms`);
  }

  async runCommand(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult> {
    const cwd = options?.cwd ? this.resolveSafe(options.cwd) : this.root;
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = options?.timeoutMs ?? 30_000;
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs),
    );

    await Promise.race([proc.exited, deadline]);

    return {
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      exitCode: proc.exitCode ?? 1,
    };
  }
}
