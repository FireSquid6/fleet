import { relative, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { createConnection } from "node:net";
import { DockerClient } from "@docker/node-sdk";
import type { Filesystem, DirectoryEntry, ContentMatch, CommandResult, ProcessHandle } from "./index";
import { LocalFilesystem } from "./local";

export class LocalDockerFilesystem implements Filesystem {
  private local: LocalFilesystem;
  private client: DockerClient;
  private containerId: string;
  private hostWorkspacePath: string;
  private containerWorkspacePath: string;

  constructor(params: {
    client: DockerClient;
    containerId: string;
    // The host directory that is bind-mounted into the container
    hostWorkspacePath: string;
    // Where that directory is mounted inside the container
    containerWorkspacePath: string;
  }) {
    this.client = params.client;
    this.containerId = params.containerId;
    this.hostWorkspacePath = resolve(params.hostWorkspacePath);
    this.containerWorkspacePath = params.containerWorkspacePath;
    this.local = new LocalFilesystem(this.hostWorkspacePath);
  }

  getType(): string {
    return "local-docker";
  }

  getRootPath(): string {
    return this.hostWorkspacePath;
  }

  // Translates a host-absolute path back to its container equivalent
  private toContainerPath(hostAbsPath: string): string {
    const rel = relative(this.hostWorkspacePath, hostAbsPath);
    return join(this.containerWorkspacePath, rel);
  }

  readFile(path: string): Promise<string> {
    return this.local.readFile(path);
  }

  writeFile(path: string, contents: string): Promise<void> {
    return this.local.writeFile(path, contents);
  }

  editFile(path: string, oldString: string, newString: string): Promise<void> {
    return this.local.editFile(path, oldString, newString);
  }

  deleteFile(path: string): Promise<void> {
    return this.local.deleteFile(path);
  }

  listDirectory(path: string): Promise<DirectoryEntry[]> {
    return this.local.listDirectory(path);
  }

  searchFiles(pattern: string, directory?: string): Promise<string[]> {
    return this.local.searchFiles(pattern, directory);
  }

  searchContent(pattern: string, directory?: string): Promise<ContentMatch[]> {
    return this.local.searchContent(pattern, directory);
  }

  async startProcess(command: string, options?: { cwd?: string }): Promise<ProcessHandle> {
    const hostCwd = options?.cwd
      ? resolve(join(this.hostWorkspacePath, options.cwd))
      : this.hostWorkspacePath;
    const containerCwd = this.toContainerPath(hostCwd);

    // Run the command detached inside the container and capture its PID
    const result = await this.runCommand(
      `nohup bash -c ${JSON.stringify(command)} &>/dev/null & echo $!`,
      { cwd: containerCwd, timeoutMs: 5_000 },
    );
    const pid = result.stdout.trim();
    if (!pid || isNaN(Number(pid))) throw new Error("Failed to start process: could not get PID");
    return { id: pid };
  }

  async stopProcess(handle: ProcessHandle): Promise<void> {
    await this.runCommand(`kill ${handle.id}`, { timeoutMs: 5_000 });
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
    // Resolve the cwd to a container path so the command runs in the right directory
    const hostCwd = options?.cwd
      ? resolve(join(this.hostWorkspacePath, options.cwd))
      : this.hostWorkspacePath;
    const containerCwd = this.toContainerPath(hostCwd);

    const { Id: execId } = await this.client.containerExec(this.containerId, {
      Cmd: ["bash", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: containerCwd,
    });

    if (!execId) throw new Error("Docker exec did not return an ID");

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdoutStream.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    stderrStream.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timeoutMs = options?.timeoutMs ?? 30_000;
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    await Promise.race([
      this.client.execStart(execId, stdoutStream, stderrStream),
      deadline,
    ]);

    const inspect = await this.client.execInspect(execId);

    return {
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: Buffer.concat(stderrChunks).toString(),
      exitCode: inspect.ExitCode ?? 1,
    };
  }
}
