export interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
}

export interface ContentMatch {
  file: string;
  line: number;
  text: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessHandle {
  id: string;
}

export interface Filesystem {
  // local, remote, docker, etc.
  getType(): string;
  getRootPath(): string;

  // File I/O
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  editFile(path: string, oldString: string, newString: string): Promise<void>;
  deleteFile(path: string): Promise<void>;

  // Navigation
  listDirectory(path: string): Promise<DirectoryEntry[]>;
  searchFiles(pattern: string, directory?: string): Promise<string[]>;
  searchContent(pattern: string, directory?: string): Promise<ContentMatch[]>;

  // Execution
  runCommand(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
  startProcess(command: string, options?: { cwd?: string }): Promise<ProcessHandle>;
  stopProcess(handle: ProcessHandle): Promise<void>;
  waitForPort(port: number, options?: { hostname?: string; timeoutMs?: number }): Promise<void>;
}
